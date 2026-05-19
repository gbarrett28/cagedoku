import { describe, it, expect } from 'vitest';
import { resolveDigitKey } from './resolveDigitKey.js';

describe('resolveDigitKey', () => {
  // Normal mode, no Ctrl — place digit
  it('normal mode + no ctrl + digit → placeDigit', () => {
    expect(resolveDigitKey(false, false, '5')).toEqual({ action: 'placeDigit', digit: 5 });
  });
  it('normal mode + no ctrl + Backspace → placeDigit digit 0', () => {
    expect(resolveDigitKey(false, false, 'Backspace')).toEqual({ action: 'placeDigit', digit: 0 });
  });

  // Normal mode, Ctrl — cycle candidate
  it('normal mode + ctrl + digit → cycleCandidate', () => {
    expect(resolveDigitKey(false, true, '3')).toEqual({ action: 'cycleCandidate', digit: 3 });
  });
  it('normal mode + ctrl + Delete → cycleCandidate digit 0', () => {
    expect(resolveDigitKey(false, true, 'Delete')).toEqual({ action: 'cycleCandidate', digit: 0 });
  });

  // Candidate mode, no Ctrl — cycle candidate
  it('candidate mode + no ctrl + digit → cycleCandidate', () => {
    expect(resolveDigitKey(true, false, '7')).toEqual({ action: 'cycleCandidate', digit: 7 });
  });
  it('candidate mode + no ctrl + Backspace → cycleCandidate digit 0', () => {
    expect(resolveDigitKey(true, false, 'Backspace')).toEqual({ action: 'cycleCandidate', digit: 0 });
  });

  // Candidate mode, Ctrl — place digit
  it('candidate mode + ctrl + digit → placeDigit', () => {
    expect(resolveDigitKey(true, true, '1')).toEqual({ action: 'placeDigit', digit: 1 });
  });
  it('candidate mode + ctrl + Delete → placeDigit digit 0', () => {
    expect(resolveDigitKey(true, true, 'Delete')).toEqual({ action: 'placeDigit', digit: 0 });
  });

  // Non-digit keys return null
  it('returns null for unrelated keys', () => {
    expect(resolveDigitKey(false, false, 'ArrowUp')).toBeNull();
    expect(resolveDigitKey(false, true, 'Enter')).toBeNull();
  });
});
