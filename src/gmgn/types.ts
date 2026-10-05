// Shapes of GMGN responses that this service reads. Only fields verified on
// raw responses (fixtures/, docs/gmgn-fields.md) are listed. Numbers that
// GMGN sends as strings are typed as `string | number` and parsed by callers.

export type Num = string | number;

export interface FeedTrade {
  transaction_hash: string;
  maker: string;
  side: 'buy' | 'sell';
  base_address: string;
  amount_usd: number;
  token_amount: number;
  price_usd: number;
  buy_cost_usd: number;
  is_open_or_close: number;
  timestamp: number;
  base_token?: { symbol?: string; logo?: string; total_supply?: string; launchpad?: string };
  maker_info?: { tags?: string[]; twitter_username?: string; twitter_name?: string; name?: string; avatar?: string };
}

export interface FeedResponse {
  list: FeedTrade[];
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name?: string;
  logo?: string;
  price?: { price?: Num; price_1h?: Num; price_24h?: Num; volume_1h?: Num; volume_24h?: Num };
  circulating_supply?: Num;
  total_supply?: Num;
  liquidity?: Num;
  holder_count?: number;
  creation_timestamp?: number;
  open_timestamp?: number;
  ath_price?: Num;
  launchpad?: string;
  launchpad_platform?: string;
  stat?: Record<string, Num>;
  wallet_tags_stat?: Record<string, number>;
}

export interface TokenSecurity {
  renounced_mint?: boolean;
  renounced_freeze_account?: boolean;
  top_10_holder_rate?: Num;
  burn_status?: string;
  buy_tax?: Num;
  sell_tax?: Num;
  is_show_alert?: boolean;
  flags?: string[];
}

export interface TokenTrader {
  address: string;
  addr_type: number;
  avg_cost: number;
  history_bought_cost: number;
  profit: number;
  realized_profit: number;
  unrealized_profit: number;
  start_holding_at: number | null;
  end_holding_at: number | null;
  buy_tx_count_cur: number;
  sell_tx_count_cur: number;
  transfer_in: boolean;
  is_suspicious: boolean;
  tags?: string[] | null;
  maker_token_tags?: string[] | null;
  twitter_username?: string | null;
  twitter_name?: string | null;
}

export interface RankItem {
  address: string;
  symbol: string;
  price?: number | string;
  total_supply?: number | string;
  market_cap: number;
  liquidity: number;
  history_highest_market_cap: number;
  creation_timestamp: number;
  open_timestamp?: number;
  launchpad_platform?: string;
  rug_ratio?: number | null;
  is_wash_trading?: boolean;
  bundler_rate?: number | null;
  smart_degen_count?: number;
  renowned_count?: number;
}

export interface Candle {
  time: number; // ms
  open: Num;
  high: Num;
  low: Num;
  close: Num;
  volume: Num;
  amount: Num;
}

export interface WalletStats {
  wallet_address: string;
  realized_profit: Num;
  realized_profit_pnl: Num;
  buy: number;
  sell: number;
  total_cost: Num;
  last_timestamp: number;
  pnl_stat?: {
    token_num?: number;
    winrate?: number;
    pnl_lt_nd5_num?: number;
    pnl_nd5_0x_num?: number;
    pnl_0x_2x_num?: number;
    pnl_2x_5x_num?: number;
    pnl_gt_5x_num?: number;
    avg_holding_period?: number;
  };
  common?: {
    tags?: string[];
    twitter_username?: string;
    twitter_fans_num?: number;
    created_at?: number;
    fund_from_address?: string;
    fund_amount?: Num;
  };
}

export interface WalletProfit {
  wallet_address: string;
  realized_profit: Num;
  unrealized_profit: Num;
  total_profit: Num;
  total_cost: Num;
  buy: number;
  sell: number;
}

export interface WalletActivity {
  tx_hash: string;
  timestamp: number;
  event_type: string;
  token: { address: string; symbol?: string; logo?: string; total_supply?: string };
  token_amount: Num;
  cost_usd: Num;
  buy_cost_usd?: Num;
  price_usd: Num;
  is_open_or_close: number;
  launchpad?: string;
}
