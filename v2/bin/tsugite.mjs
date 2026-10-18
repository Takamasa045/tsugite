#!/usr/bin/env node
import { main } from '../src/cli.mjs';
try { await main(); }
catch (error) { process.stderr.write(JSON.stringify({ok:false,error:error.message})+'\n'); process.exitCode=1; }
