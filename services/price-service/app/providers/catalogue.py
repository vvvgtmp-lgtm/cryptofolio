"""The coins CryptoFolio tracks with the offline (mock) and exchange-based (binance) providers.

Ids follow CoinGecko's naming, so portfolios keep working when PRICE_PROVIDER changes.
"""

DAY = 86400

# id, symbol, name, base price (USD), circulating supply
CATALOGUE: list[tuple[str, str, str, float, float]] = [
    ("bitcoin", "btc", "Bitcoin", 65000.0, 19.7e6),
    ("ethereum", "eth", "Ethereum", 3200.0, 120e6),
    ("tether", "usdt", "Tether", 1.0, 110e9),
    ("binancecoin", "bnb", "BNB", 580.0, 146e6),
    ("solana", "sol", "Solana", 150.0, 460e6),
    ("ripple", "xrp", "XRP", 0.52, 55e9),
    ("usd-coin", "usdc", "USDC", 1.0, 33e9),
    ("cardano", "ada", "Cardano", 0.45, 35e9),
    ("dogecoin", "doge", "Dogecoin", 0.15, 145e9),
    ("tron", "trx", "TRON", 0.12, 87e9),
    ("avalanche-2", "avax", "Avalanche", 35.0, 400e6),
    ("polkadot", "dot", "Polkadot", 7.0, 1.4e9),
    ("chainlink", "link", "Chainlink", 15.0, 600e6),
    ("litecoin", "ltc", "Litecoin", 80.0, 75e6),
    ("near", "near", "NEAR Protocol", 5.5, 1.1e9),
    ("uniswap", "uni", "Uniswap", 9.0, 600e6),
    ("stellar", "xlm", "Stellar", 0.11, 29e9),
    ("cosmos", "atom", "Cosmos Hub", 8.0, 390e6),
    ("monero", "xmr", "Monero", 160.0, 18e6),
    ("aptos", "apt", "Aptos", 9.0, 450e6),
]
STABLECOINS = {"tether", "usd-coin"}
# Chart ranges (days) -> spacing between history points (seconds)
HISTORY_STEP_SECONDS = {1: 300, 7: 3600, 30: 14400, 365: DAY}
