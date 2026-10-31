import { User } from '../models/userModel.js';
import { Student } from '../models/studentModel.js';
import { verifyToken } from '../utils/tokens.js';

const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
};

/** Verifies the access token and attaches the live user document to the request. */
export const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const payload = verifyToken(token, 'access');

    if (payload.role === 'student') {
      const student = await Student.findById(payload.sub);
      if (!student || student.deletedAt) {
        return res.status(401).json({ success: false, message: 'Account no longer exists' });
      }
      if (student.status !== 'active') {
        return res.status(401).json({ success: false, message: `Account is ${student.status}` });
      }
      req.user = {
        _id: student._id,
        role: 'student',
        schoolId: student.schoolId,
        studentId: student._id,
        status: student.status,
      };
      req.auth = payload;
      return next();
    }

    const user = await User.findById(payload.sub);

    if (!user || user.deletedAt) {
      return res.status(401).json({ success: false, message: 'Account no longer exists' });
    }

    // A suspended or deactivated account must lose access immediately, without
    // waiting for its token to expire.
    if (user.status !== 'active') {
      return res.status(401).json({
        success: false,
        message: `Account is ${user.status}`,
      });
    }

    if (payload.tokenVersion !== undefined && payload.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ success: false, message: 'Session has been revoked' });
    }

    req.user = user;
    req.auth = payload;
    next();
  } catch (error) {
    const expired = error.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      message: expired ? 'Access token expired' : 'Invalid or malformed token',
    });
  }
};

/** Restricts a route to the given roles. */
export const authorize =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this resource' });
    }
    next();
  };
