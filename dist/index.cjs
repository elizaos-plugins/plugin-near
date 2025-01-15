'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var core = require('@elizaos/core');
var nearApiJs = require('near-api-js');
var BigNumber = require('bignumber.js');
var NodeCache = require('node-cache');
var refSdk = require('@ref-finance/ref-sdk');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var BigNumber__default = /*#__PURE__*/_interopDefault(BigNumber);
var NodeCache__default = /*#__PURE__*/_interopDefault(NodeCache);

// src/providers/wallet.ts
var PROVIDER_CONFIG = {
  networkId: process.env.NEAR_NETWORK || "testnet",
  nodeUrl: process.env.NEAR_RPC_URL || `https://rpc.${process.env.NEAR_NETWORK || "testnet"}.near.org`,
  walletUrl: `https://${process.env.NEAR_NETWORK || "testnet"}.mynearwallet.com/`,
  helperUrl: `https://helper.${process.env.NEAR_NETWORK || "testnet"}.near.org`,
  explorerUrl: `https://${process.env.NEAR_NETWORK || "testnet"}.nearblocks.io`,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2e3,
  SLIPPAGE: process.env.NEAR_SLIPPAGE ? parseInt(process.env.NEAR_SLIPPAGE) : 1
};
var WalletProvider = class {
  constructor(accountId) {
    this.accountId = accountId;
    this.account = null;
    this.cache = new NodeCache__default.default({ stdTTL: 300 });
    this.keyStore = new nearApiJs.keyStores.InMemoryKeyStore();
  }
  async get(runtime, _message, _state) {
    try {
      return await this.getFormattedPortfolio(runtime);
    } catch (error) {
      core.elizaLogger.error("Error in wallet provider:", error);
      return null;
    }
  }
  async connect(runtime) {
    if (this.account) return this.account;
    const secretKey = runtime.getSetting("NEAR_WALLET_SECRET_KEY");
    const publicKey = runtime.getSetting("NEAR_WALLET_PUBLIC_KEY");
    if (!secretKey || !publicKey) {
      throw new Error("NEAR wallet credentials not configured");
    }
    const keyPair = nearApiJs.KeyPair.fromString(secretKey);
    await this.keyStore.setKey(
      PROVIDER_CONFIG.networkId,
      this.accountId,
      keyPair
    );
    const nearConnection = await nearApiJs.connect({
      networkId: PROVIDER_CONFIG.networkId,
      keyStore: this.keyStore,
      nodeUrl: PROVIDER_CONFIG.nodeUrl,
      walletUrl: PROVIDER_CONFIG.walletUrl,
      helperUrl: PROVIDER_CONFIG.helperUrl
    });
    this.account = await nearConnection.account(this.accountId);
    return this.account;
  }
  async fetchWithRetry(url, options = {}) {
    let lastError;
    for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        core.elizaLogger.error(`Attempt ${i + 1} failed:`, error);
        lastError = error;
        if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
          await new Promise(
            (resolve) => setTimeout(
              resolve,
              PROVIDER_CONFIG.RETRY_DELAY * Math.pow(2, i)
            )
          );
        }
      }
    }
    throw lastError;
  }
  async fetchPortfolioValue(runtime) {
    try {
      const cacheKey = `portfolio-${this.accountId}`;
      const cachedValue = this.cache.get(cacheKey);
      if (cachedValue) {
        core.elizaLogger.log("Cache hit for fetchPortfolioValue");
        return cachedValue;
      }
      const account = await this.connect(runtime);
      const balance = await account.getAccountBalance();
      const nearBalance = nearApiJs.utils.format.formatNearAmount(
        balance.available
      );
      const nearPrice = await this.fetchNearPrice();
      const valueUsd = new BigNumber__default.default(nearBalance).times(nearPrice);
      const portfolio = {
        totalUsd: valueUsd.toString(),
        totalNear: nearBalance,
        tokens: [
          {
            name: "NEAR Protocol",
            symbol: "NEAR",
            decimals: 24,
            balance: balance.available,
            uiAmount: nearBalance,
            priceUsd: nearPrice.toString(),
            valueUsd: valueUsd.toString()
          }
        ]
      };
      this.cache.set(cacheKey, portfolio);
      return portfolio;
    } catch (error) {
      core.elizaLogger.error("Error fetching portfolio:", error);
      throw error;
    }
  }
  async fetchNearPrice() {
    const cacheKey = "near-price";
    const cachedPrice = this.cache.get(cacheKey);
    if (cachedPrice) {
      return cachedPrice;
    }
    try {
      const response = await this.fetchWithRetry(
        "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd"
      );
      const price = response.near.usd;
      this.cache.set(cacheKey, price);
      return price;
    } catch (error) {
      core.elizaLogger.error("Error fetching NEAR price:", error);
      return 0;
    }
  }
  formatPortfolio(runtime, portfolio) {
    let output = `${runtime.character.system}
`;
    output += `Account ID: ${this.accountId}

`;
    const totalUsdFormatted = new BigNumber__default.default(portfolio.totalUsd).toFixed(2);
    const totalNearFormatted = portfolio.totalNear;
    output += `Total Value: $${totalUsdFormatted} (${totalNearFormatted} NEAR)

`;
    output += "Token Balances:\n";
    for (const token of portfolio.tokens) {
      output += `${token.name} (${token.symbol}): ${token.uiAmount} ($${new BigNumber__default.default(token.valueUsd).toFixed(2)})
`;
    }
    output += "\nMarket Prices:\n";
    output += `NEAR: $${new BigNumber__default.default(portfolio.tokens[0].priceUsd).toFixed(2)}
`;
    return output;
  }
  async getFormattedPortfolio(runtime) {
    try {
      const portfolio = await this.fetchPortfolioValue(runtime);
      return this.formatPortfolio(runtime, portfolio);
    } catch (error) {
      core.elizaLogger.error("Error generating portfolio report:", error);
      return "Unable to fetch wallet information. Please try again later.";
    }
  }
};
var walletProvider = {
  get: async (runtime, _message, _state) => {
    try {
      const accountId = runtime.getSetting("NEAR_ADDRESS");
      if (!accountId) {
        throw new Error("NEAR_ADDRESS not configured");
      }
      const provider = new WalletProvider(accountId);
      return await provider.getFormattedPortfolio(runtime);
    } catch (error) {
      core.elizaLogger.error("Error in wallet provider:", error);
      return null;
    }
  }
};
async function checkStorageBalance(account, contractId) {
  try {
    const balance = await account.viewFunction({
      contractId,
      methodName: "storage_balance_of",
      args: { account_id: account.accountId }
    });
    return balance !== null && balance.total !== "0";
  } catch (error) {
    core.elizaLogger.log(`Error checking storage balance: ${error}`);
    return false;
  }
}
async function swapToken(runtime, inputTokenId, outputTokenId, amount, slippageTolerance = Number(
  runtime.getSetting("SLIPPAGE_TOLERANCE")
) || 0.01) {
  try {
    const tokenIn = await refSdk.ftGetTokenMetadata(inputTokenId);
    const tokenOut = await refSdk.ftGetTokenMetadata(outputTokenId);
    const networkId = runtime.getSetting("NEAR_NETWORK") || "testnet";
    const nodeUrl = runtime.getSetting("NEAR_RPC_URL") || "https://rpc.testnet.near.org";
    const { simplePools } = await refSdk.fetchAllPools();
    const swapTodos = await refSdk.estimateSwap({
      tokenIn,
      tokenOut,
      amountIn: amount,
      simplePools,
      options: {
        enableSmartRouting: true
      }
    });
    if (!swapTodos || swapTodos.length === 0) {
      throw new Error("No valid swap route found");
    }
    const accountId = runtime.getSetting("NEAR_ADDRESS");
    if (!accountId) {
      throw new Error("NEAR_ADDRESS not configured");
    }
    const secretKey = runtime.getSetting("NEAR_WALLET_SECRET_KEY");
    const keyStore = new nearApiJs.keyStores.InMemoryKeyStore();
    const keyPair = nearApiJs.utils.KeyPair.fromString(secretKey);
    await keyStore.setKey(networkId, accountId, keyPair);
    const nearConnection = await nearApiJs.connect({
      networkId,
      keyStore,
      nodeUrl
    });
    const account = await nearConnection.account(accountId);
    const hasStorageIn = await checkStorageBalance(account, inputTokenId);
    const hasStorageOut = await checkStorageBalance(account, outputTokenId);
    const transactions = await refSdk.instantSwap({
      tokenIn,
      tokenOut,
      amountIn: amount,
      swapTodos,
      slippageTolerance,
      AccountId: accountId
    });
    if (!hasStorageIn) {
      transactions.unshift({
        receiverId: inputTokenId,
        functionCalls: [
          {
            methodName: "storage_deposit",
            args: {
              account_id: accountId,
              registration_only: true
            },
            gas: "30000000000000",
            amount: refSdk.FT_MINIMUM_STORAGE_BALANCE_LARGE
          }
        ]
      });
    }
    if (!hasStorageOut) {
      transactions.unshift({
        receiverId: outputTokenId,
        functionCalls: [
          {
            methodName: "storage_deposit",
            args: {
              account_id: accountId,
              registration_only: true
            },
            gas: "30000000000000",
            amount: refSdk.FT_MINIMUM_STORAGE_BALANCE_LARGE
          }
        ]
      });
    }
    return transactions;
  } catch (error) {
    core.elizaLogger.error("Error in swapToken:", error);
    throw error;
  }
}
var swapTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "inputTokenId": "wrap.testnet",
    "outputTokenId": "ref.fakes.testnet",
    "amount": "1.5"
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token swap:
- Input token ID (the token being sold)
- Output token ID (the token being bought)
- Amount to swap

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined. The result should be a valid JSON object with the following schema:
\`\`\`json
{
    "inputTokenId": string | null,
    "outputTokenId": string | null,
    "amount": string | null
}
\`\`\``;
var executeSwap = {
  name: "EXECUTE_SWAP_NEAR",
  similes: [
    "SWAP_TOKENS_NEAR",
    "TOKEN_SWAP_NEAR",
    "TRADE_TOKENS_NEAR",
    "EXCHANGE_TOKENS_NEAR"
  ],
  validate: async (_runtime, message) => {
    core.elizaLogger.log("Message:", message);
    return true;
  },
  description: "Perform a token swap using Ref Finance.",
  handler: async (runtime, message, state, _options, callback) => {
    refSdk.init_env(runtime.getSetting("NEAR_NETWORK") || "testnet");
    if (!state) {
      state = await runtime.composeState(message);
    } else {
      state = await runtime.updateRecentMessageState(state);
    }
    const walletInfo = await walletProvider.get(runtime, message, state);
    state.walletInfo = walletInfo;
    const swapContext = core.composeContext({
      state,
      template: swapTemplate
    });
    const response = await core.generateObject({
      runtime,
      context: swapContext,
      modelClass: core.ModelClass.LARGE
    });
    core.elizaLogger.log("Response:", response);
    if (!response.inputTokenId || !response.outputTokenId || !response.amount) {
      core.elizaLogger.log("Missing required parameters, skipping swap");
      const responseMsg = {
        text: "I need the input token ID, output token ID, and amount to perform the swap"
      };
      callback?.(responseMsg);
      return true;
    }
    try {
      const accountId = runtime.getSetting("NEAR_ADDRESS");
      const secretKey = runtime.getSetting("NEAR_WALLET_SECRET_KEY");
      if (!accountId || !secretKey) {
        throw new Error("NEAR wallet credentials not configured");
      }
      const keyStore = new nearApiJs.keyStores.InMemoryKeyStore();
      const keyPair = nearApiJs.utils.KeyPair.fromString(
        secretKey
      );
      await keyStore.setKey("testnet", accountId, keyPair);
      const nearConnection = await nearApiJs.connect({
        networkId: runtime.getSetting("NEAR_NETWORK") || "testnet",
        keyStore,
        nodeUrl: runtime.getSetting("NEAR_RPC_URL") || "https://rpc.testnet.near.org"
      });
      const swapResult = await swapToken(
        runtime,
        response.inputTokenId,
        response.outputTokenId,
        response.amount,
        Number(runtime.getSetting("SLIPPAGE_TOLERANCE")) || 0.01
      );
      const account = await nearConnection.account(accountId);
      const results = [];
      for (const tx of swapResult) {
        for (const functionCall of tx.functionCalls) {
          const result = await account.functionCall({
            contractId: tx.receiverId,
            methodName: functionCall.methodName,
            args: functionCall.args,
            gas: functionCall.gas,
            attachedDeposit: BigInt(
              functionCall.amount === refSdk.ONE_YOCTO_NEAR ? "1" : functionCall.amount
            )
          });
          results.push(result);
        }
      }
      core.elizaLogger.log("Swap completed successfully!");
      const txHashes = results.map((r) => r.transaction.hash).join(", ");
      const responseMsg = {
        text: `Swap completed successfully! Transaction hashes: ${txHashes}`
      };
      callback?.(responseMsg);
      return true;
    } catch (error) {
      core.elizaLogger.error("Error during token swap:", error);
      const responseMsg = {
        text: `Error during swap: ${error instanceof Error ? error.message : String(error)}`
      };
      callback?.(responseMsg);
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          inputTokenId: "wrap.testnet",
          outputTokenId: "ref.fakes.testnet",
          amount: "1.0"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Swapping 1.0 NEAR for REF...",
          action: "TOKEN_SWAP"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Swap completed successfully! Transaction hash: ..."
        }
      }
    ]
  ]
};
function isTransferContent(runtime, content) {
  return typeof content.recipient === "string" && (typeof content.amount === "string" || typeof content.amount === "number");
}
var transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "bob.near",
    "amount": "1.5",
    "tokenAddress": null
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token transfer:
- Recipient address (NEAR account)
- Amount to transfer
- Token contract address (null for native NEAR transfers)

Respond with a JSON markdown block containing only the extracted values.`;
async function transferNEAR(runtime, recipient, amount) {
  const networkId = runtime.getSetting("NEAR_NETWORK") || "testnet";
  const nodeUrl = runtime.getSetting("NEAR_RPC_URL") || "https://rpc.testnet.near.org";
  const accountId = runtime.getSetting("NEAR_ADDRESS");
  const secretKey = runtime.getSetting("NEAR_WALLET_SECRET_KEY");
  if (!accountId || !secretKey) {
    throw new Error("NEAR wallet credentials not configured");
  }
  const keyStore = new nearApiJs.keyStores.InMemoryKeyStore();
  const keyPair = nearApiJs.utils.KeyPair.fromString(secretKey);
  await keyStore.setKey(networkId, accountId, keyPair);
  const nearConnection = await nearApiJs.connect({
    networkId,
    keyStore,
    nodeUrl
  });
  const account = await nearConnection.account(accountId);
  const result = await account.sendMoney(
    recipient,
    BigInt(nearApiJs.utils.format.parseNearAmount(amount))
  );
  return result.transaction.hash;
}
var executeTransfer = {
  name: "SEND_NEAR",
  similes: ["TRANSFER_NEAR", "SEND_TOKENS", "TRANSFER_TOKENS", "PAY_NEAR"],
  validate: async (_runtime, _message) => {
    return true;
  },
  description: "Transfer NEAR tokens to another account",
  handler: async (runtime, message, state, _options, callback) => {
    if (!state) {
      state = await runtime.composeState(message);
    } else {
      state = await runtime.updateRecentMessageState(state);
    }
    const transferContext = core.composeContext({
      state,
      template: transferTemplate
    });
    const content = await core.generateObject({
      runtime,
      context: transferContext,
      modelClass: core.ModelClass.SMALL
    });
    if (!isTransferContent(runtime, content)) {
      core.elizaLogger.error("Invalid content for TRANSFER_NEAR action.");
      if (callback) {
        callback({
          text: "Unable to process transfer request. Invalid content provided.",
          content: { error: "Invalid transfer content" }
        });
      }
      return false;
    }
    try {
      const txHash = await transferNEAR(
        runtime,
        content.recipient,
        content.amount.toString()
      );
      if (callback) {
        callback({
          text: `Successfully transferred ${content.amount} NEAR to ${content.recipient}
Transaction: ${txHash}`,
          content: {
            success: true,
            signature: txHash,
            amount: content.amount,
            recipient: content.recipient
          }
        });
      }
      return true;
    } catch (error) {
      core.elizaLogger.error("Error during NEAR transfer:", error);
      if (callback) {
        callback({
          text: `Error transferring NEAR: ${error}`,
          content: { error }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Send 1.5 NEAR to bob.testnet"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll send 1.5 NEAR now...",
          action: "SEND_NEAR"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Successfully sent 1.5 NEAR to bob.testnet\nTransaction: ABC123XYZ"
        }
      }
    ]
  ]
};

// src/index.ts
var nearPlugin = {
  name: "NEAR",
  description: "Near Protocol Plugin for Eliza",
  providers: [walletProvider],
  actions: [executeSwap, executeTransfer],
  evaluators: []
};
var index_default = nearPlugin;

exports.default = index_default;
exports.nearPlugin = nearPlugin;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map