import crypto from 'node:crypto';
import { User } from '../models/userModel.js';
import { sendEmail } from '../services/emailService.js';
import { verificationEmail, invitationEmail } from '../templates/emails.js';
import { EMAIL_OTP_EXPIRE_MINUTES } from '../config/env.js';
import {
  generateEmailOtp,
  hashToken,
  emailOtpExpiry,
} from '../utils/tokens.js';

const sameSchoolOrAdmin = (requester, target) => {
  if (requester.role === 'super_admin') return true;
  return Boolean(target.schoolId) &&
    Boolean(requester.schoolId) &&
    target.schoolId.toString() === requester.schoolId.toString();
};

export const inviteUser = async (req, res) => {
  try {
    const { name, email, phone, role, position, schoolId } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
      });
    }

    const tempPassword = crypto.randomBytes(16).toString('hex');
    const targetSchoolId =
      req.user.role === 'super_admin' ? (schoolId || req.user.schoolId) : req.user.schoolId;

    const user = await User.create({
      name,
      email,
      phone,
      password: tempPassword,
      role,
      position: position || null,
      status: 'invited',
      schoolId: targetSchoolId,
      invitedBy: req.user._id,
    });

    const otp = generateEmailOtp();
    user.emailVerificationToken = hashToken(otp);
    user.emailVerificationExpires = emailOtpExpiry();
    await user.save();

    const { subject, html } = invitationEmail({
      name: user.name,
      otp,
      expiresInMinutes: EMAIL_OTP_EXPIRE_MINUTES,
      inviter: req.user.name,
    });

    try {
      await sendEmail({ to: user.email, toName: user.name, subject, html });
    } catch (emailError) {
      console.error('Invitation email failed:', emailError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Invitation sent successfully. A verification code has been emailed to the invitee.',
      user: user.toJSON(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const listUsers = async (req, res) => {
  try {
    const { schoolId, page = 1, limit = 50, role, status } = req.query;

    let targetSchoolId;
    if (req.user.role === 'super_admin') {
      targetSchoolId = schoolId || req.user.schoolId;
    } else {
      targetSchoolId = req.user.schoolId;
      if (schoolId && schoolId !== String(req.user.schoolId)) {
        return res.status(403).json({
          success: false,
          message: 'You can only view users from your own school',
        });
      }
    }

    const query = { deletedAt: null };
    if (targetSchoolId) query.schoolId = targetSchoolId;
    if (role) query.role = role;
    if (status) query.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [users, total] = await Promise.all([
      User.find(query).skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
      User.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      users,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    return res.status(200).json({
      success: true,
      user: user.toJSON(),
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email, role, position, phone, onboardingCompleted, onboardingHighestStep } = req.body;

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    if (role && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only a super admin can change roles',
      });
    }

    if (email && email !== user.email) {
      const emailConflict = await User.findOne({ email, _id: { $ne: userId } });
      if (emailConflict) {
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists',
        });
      }
      user.email = email;
    }

    if (name) user.name = name;
    if (role) user.role = role;
    if (position !== undefined) user.position = position || null;
    if (phone) user.phone = phone;

    // Wizard progress. Restricted to the account itself: `sameSchoolOrAdmin`
    // above lets a school_admin edit their colleagues, and letting one admin
    // mark another's onboarding complete would skip a bursar straight into a
    // dashboard for a school they never configured.
    if (req.user._id.toString() === user._id.toString()) {
      if (onboardingCompleted !== undefined) user.onboardingCompleted = onboardingCompleted;
      if (onboardingHighestStep !== undefined) {
        user.onboardingHighestStep = onboardingHighestStep;
      }
    }

    await user.save();

    return res.status(200).json({
      success: true,
      message: 'User updated successfully',
      user: user.toJSON(),
      onboarding: {
        completed: user.onboardingCompleted === true,
        highestStep: user.onboardingHighestStep ?? 0,
      },
    });

  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const changeUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    if (role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only a super admin can assign the super_admin role',
      });
    }

    user.role = role;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'User role updated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    if (userId === String(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account',
      });
    }

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!sameSchoolOrAdmin(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource',
      });
    }

    if (user.role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete a super admin account',
      });
    }

    user.deletedAt = new Date();
    user.tokenVersion += 1;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'User removed successfully',
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
