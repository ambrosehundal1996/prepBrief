/**
 * Vercel serverless entry: mounts the Express app at /api/*
 * @see https://vercel.com/docs/functions/runtimes/node-js
 */
const app = require("../server");

module.exports = app;
