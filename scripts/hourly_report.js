#!/usr/bin/env node
'use strict';
/**
 * Deprecated Bark entry point.
 * Forwards once to ../report.js and does not run a second report implementation.
 * Schedule either this file or report.js, never both.
 */
const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'report.js')], {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (error) => {
  console.error('[hourly_report]', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 1 : code);
});
