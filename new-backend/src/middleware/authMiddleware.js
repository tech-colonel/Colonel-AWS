const jwt = require('jsonwebtoken');
const { User } = require('../models/master');
const { als } = require('../utils/requestContext');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    req.user = user;
    // Run the rest of the request inside an AsyncLocalStorage context so
    // dynamic-table model hooks (e.g. created_by defaults) can read the
    // acting user without every controller threading it through explicitly.
    als.run({ userId: user.id }, next);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const authorize = (...roles) => {
  // Fail FAST, at route-definition time, on `authorize()` with no roles.
  //
  // It reads like "any authenticated user", but it evaluates `[].includes(req.user.role)`,
  // which is false for every role — so the route returns 403 to everyone, admin included.
  // Four bank-corrections routes carried this for months: inline correction saving and both
  // bulk-upload endpoints were silently dead, and nothing in the logs said so.
  //
  // Throwing here surfaces the mistake the moment the server boots instead of as a runtime
  // 403. Deliberately NOT defaulted to "allow any role" — that would silently widen access.
  if (roles.length === 0) {
    throw new Error(
      'authorize() requires at least one role, e.g. authorize("admin", "accountant"). ' +
      'Called with none, it denies every role including admin.'
    );
  }
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Unauthorized role.' });
    }
    next();
  };
};

module.exports = {
  authenticateToken,
  authorize
};
