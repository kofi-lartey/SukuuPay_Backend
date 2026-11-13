import { User } from '../models/userModel.js';
import { Student } from '../models/studentModel.js';
import { verifyToken } from '../utils/tokens.js';

const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
};

/** Extracts and verifies token from socket auth or request headers. Returns user object or throws. */
export const authenticateUser = async (token) => {
  if (!token) {
    throw new Error('Authentication required');
  }

  const payload = verifyToken(token, 'access');

  if (payload.role === 'student') {
    const student = await Student.findById(payload.sub);
    if (!student || student.deletedAt) {
      throw new Error('Account no longer exists');
    }
    if (student.status !== 'active') {
      throw new Error(`Account is ${student.status}`);
    }
    return {
      _id: student._id,
      role: 'student',
      schoolId: student.schoolId,
      studentId: student._id,
      status: student.status,
      // The Student collection has no `name` or `avatar`; it stores
      // `studentName`, `firstName`/`lastName` and `studentImage`. Without these
      // three the community feed had nothing to snapshot and every post and
      // comment written by a student rendered as "Unknown" — see
      // `utils/communityAuthor.js`.
      name: student.studentName,
      firstName: student.firstName,
      lastName: student.lastName,
      avatar: student.studentImage || null,
    };
  }

  const user = await User.findById(payload.sub);

  if (!user || user.deletedAt) {
    throw new Error('Account no longer exists');
  }

  if (user.status !== 'active') {
    throw new Error(`Account is ${user.status}`);
  }

  if (payload.tokenVersion !== undefined && payload.tokenVersion !== user.tokenVersion) {
    throw new Error('Session has been revoked');
  }

  return user;
};

/** Verifies the access token and attaches the live user document to the request. */
export const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    const user = await authenticateUser(token);
    req.user = user;
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
