#!/usr/bin/env node
// Set before React and React Router load, so they pick their production builds.
process.env.NODE_ENV = "production";
await import("../dist/main.js");
