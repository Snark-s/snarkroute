import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteWindowsArg, rotatedLogPath, trampolineCommandLine } from './windowless-launch.mjs';

test('arguments are quoted so cmd.exe treats metacharacters literally', () => {
  assert.equal(quoteWindowsArg('serve'), 'serve');
  assert.equal(quoteWindowsArg('C:\\Program Files\\x.exe'), '"C:\\Program Files\\x.exe"');
  assert.equal(quoteWindowsArg('a&b'), '"a&b"');
  assert.equal(quoteWindowsArg('dir\\'), 'dir\\');
  assert.equal(quoteWindowsArg('my dir\\'), '"my dir\\\\"');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(trampolineCommandLine('ollama.exe', ['serve']), 'ollama.exe serve');
});

test('quotes, percent signs and newlines are refused instead of being passed to cmd.exe', () => {
  for (const unsafe of ['a"b', '%PATH%', 'line\nbreak']) assert.throws(() => quoteWindowsArg(unsafe), /Unsafe/);
});

test('rotated log names keep the .log extension', () => {
  assert.equal(rotatedLogPath('C:/logs/bonsai-runtime.log', 2), 'C:/logs/bonsai-runtime.2.log');
});
