/**
 * requestContext.js — per-request context (currently just the authenticated
 * user id) threaded through async calls without passing it explicitly.
 *
 * Needed because pooled brand DB connections are shared across concurrent
 * requests from different users (unlike `app.brand_id`, which is safe to set
 * once per connection since each brand gets its own pool — see
 * config/database.js). Attribution fields like `created_by` must instead be
 * read per-request via AsyncLocalStorage, populated in authMiddleware.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const getCurrentUserId = () => als.getStore()?.userId || null;

module.exports = { als, getCurrentUserId };
