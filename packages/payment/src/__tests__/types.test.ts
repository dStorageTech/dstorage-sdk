import { describe, it, expect } from 'vitest';
import { TOKENS } from '../types.js';
import type { TokenSymbol } from '../types.js';

describe('TOKENS registry', () => {
  const expectedSymbols: TokenSymbol[] = ['AR', 'ANT', 'DUST', 'ETH', 'MATIC', 'MOCK'];

  it('contains all expected token symbols', () => {
    for (const symbol of expectedSymbols) {
      expect(TOKENS).toHaveProperty(symbol);
    }
  });

  it('has exactly 6 tokens', () => {
    expect(Object.keys(TOKENS)).toHaveLength(6);
  });

  // ── Per-token checks ───────────────────────────────────────────────────────

  it('AR: symbol, name, positive decimals and price', () => {
    expect(TOKENS.AR.symbol).toBe('AR');
    expect(TOKENS.AR.name).toBe('Arweave');
    expect(TOKENS.AR.decimals).toBe(12);
    expect(TOKENS.AR.approxUsdPrice).toBeGreaterThan(0);
  });

  it('ANT: symbol, name, 9 decimals, positive price', () => {
    expect(TOKENS.ANT.symbol).toBe('ANT');
    expect(TOKENS.ANT.name).toBe('Autonomi');
    expect(TOKENS.ANT.decimals).toBe(9);
    expect(TOKENS.ANT.approxUsdPrice).toBeGreaterThan(0);
  });

  it('DUST: symbol, name, 6 decimals, positive price', () => {
    expect(TOKENS.DUST.symbol).toBe('DUST');
    expect(TOKENS.DUST.name).toBe('Midnight');
    expect(TOKENS.DUST.decimals).toBe(6);
    expect(TOKENS.DUST.approxUsdPrice).toBeGreaterThan(0);
  });

  it('ETH: symbol, name, 18 decimals, positive price', () => {
    expect(TOKENS.ETH.symbol).toBe('ETH');
    expect(TOKENS.ETH.name).toBe('Ethereum');
    expect(TOKENS.ETH.decimals).toBe(18);
    expect(TOKENS.ETH.approxUsdPrice).toBeGreaterThan(1000); // ETH >> $1000
  });

  it('MATIC: symbol, name, 18 decimals, positive price', () => {
    expect(TOKENS.MATIC.symbol).toBe('MATIC');
    expect(TOKENS.MATIC.name).toBe('Polygon');
    expect(TOKENS.MATIC.decimals).toBe(18);
    expect(TOKENS.MATIC.approxUsdPrice).toBeGreaterThan(0);
  });

  it('MOCK: symbol, name, 6 decimals, price of 1.0 USD', () => {
    expect(TOKENS.MOCK.symbol).toBe('MOCK');
    expect(TOKENS.MOCK.name).toBe('Mock Token');
    expect(TOKENS.MOCK.decimals).toBe(6);
    expect(TOKENS.MOCK.approxUsdPrice).toBe(1.0);
  });

  it('all tokens have positive approxUsdPrice', () => {
    for (const symbol of expectedSymbols) {
      expect(TOKENS[symbol].approxUsdPrice).toBeGreaterThan(0);
    }
  });

  it('all tokens have positive decimal count', () => {
    for (const symbol of expectedSymbols) {
      expect(TOKENS[symbol].decimals).toBeGreaterThan(0);
    }
  });

  it('symbol field matches the registry key', () => {
    for (const [key, token] of Object.entries(TOKENS)) {
      expect(token.symbol).toBe(key);
    }
  });
});
