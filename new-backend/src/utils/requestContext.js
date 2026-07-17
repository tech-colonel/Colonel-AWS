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

// Multer's multipart parsing (busboy) drops the AsyncLocalStorage context set
// up by authenticateToken once the upload body arrives across more than one
// underlying socket read (i.e. any file past a couple hundred KB) — verified
// by instrumenting the store immediately before/after upload.single()/
// .fields() on a large vs. small file: present before, gone after, 100% of
// the time, regardless of which route or how much later bulkCreate runs.
// req.user (a plain property set by authenticateToken, unaffected by that)
// survives, so re-enter the store from it right after the multer middleware
// on every route that uploads a file into a dynamic agent table.
const reattachUserContext = (req, res, next) => {
  if (req.user?.id) als.enterWith({ userId: req.user.id });
  next();
};

module.exports = { als, getCurrentUserId, reattachUserContext };
