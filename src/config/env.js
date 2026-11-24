import dotenv from 'dotenv';

dotenv.config();
export const PORT = process.env.PORT || 2345;
export const MONGODB_URI = process.env.MONGODB_URI;
export const SECRET = process.env.JWT_SECRET;
export const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
export const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
export const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
export const CLOUDINARY_UPLOAD_FOLDER = process.env.CLOUDINARY_UPLOAD_FOLDER;

export const NODE_ENV = process.env.NODE_ENV || 'development';

export const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase() || null;
export const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || null;
export const SUPER_ADMIN_NAME = (process.env.SUPER_ADMIN_NAME || 'Platform Operations').trim();

export const JWT_EXPIRE = process.env.JWT_EXPIRE || '4h';
export const REFRESH_TOKEN_EXPIRE = process.env.REFRESH_TOKEN_EXPIRE || '7d';
export const EMAIL_OTP_EXPIRE_MINUTES = Number(process.env.EMAIL_OTP_EXPIRE_MINUTES || 15);
export const PASSWORD_RESET_EXPIRE_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRE_MINUTES || 30);

export const INVITE_PASSWORD_SUFFIX_LENGTH = Number(process.env.INVITE_PASSWORD_SUFFIX_LENGTH || 8);
export const INVITE_RATE_LIMIT_PER_HOUR = Number(process.env.INVITE_RATE_LIMIT_PER_HOUR || 25);

export const CLIENT_URL = process.env.CLIENT_URL || 'https://sukuupay.netlify.app';

export const BREVO_API_KEY = process.env.BREVO_API_KEY;
export const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
export const SMTP_FROM = process.env.SMTP_FROM;
export const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'SukuuPay';

export const BREVO_EVENT_SECRET =
  process.env.BREVO_EVENT_SECRET || process.env.BRAVO_EVENT_SECRET || process.env.BREVO_WEBHOOK_SECRET;

export const EMAIL_DAILY_QUOTA = Number(process.env.EMAIL_DAILY_QUOTA || 1000);
export const EMAIL_JOB_CONCURRENCY = Number(process.env.EMAIL_JOB_CONCURRENCY || 3);

export const API_URL = process.env.API_URL || '';
export const API_BASE_URL = process.env.API_BASE_URL || 'https://sukuupay-backend.onrender.com';

export const MOOLRE_CHECKOUT_EMAIL =
  (process.env.MOOLRE_CHECKOUT_EMAIL || process.env.SUPER_ADMIN_EMAIL || '').trim() || null;

export const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || API_BASE_URL;
export const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || '';

export const PAY_LINK_BASE_URL = process.env.PAY_LINK_BASE_URL || 'https://sukuupay.com';

export const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim() || null;
export const GOOGLE_ALLOWED_ORIGINS = (process.env.GOOGLE_ALLOWED_ORIGINS || CLIENT_URL)
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const GOOGLE_ALLOW_SIGNUP = String(
  process.env.GOOGLE_ALLOW_SIGNUP ?? 'true'
).toLowerCase() !== 'false';

export const API_NAME = process.env.API_NAME || 'SukuuPay API';
export const API_VERSION = process.env.API_VERSION || '1.0.0';
export const API_COMMIT = process.env.APP_COMMIT || process.env.GIT_COMMIT || null;
export const API_BUILD_DATE = process.env.APP_BUILD_DATE || null;

export const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === 'true';
export const WHATSAPP_COMING_SOON_MESSAGE =
  process.env.WHATSAPP_COMING_SOON_MESSAGE ||
  'WhatsApp messaging is coming soon in Version 2.';

export const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;
export const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

export const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
export const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
export const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
export const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
export const WHATSAPP_GRAPH_BASE_URL =
  process.env.WHATSAPP_GRAPH_BASE_URL || `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

export const WHATSAPP_SERVICE_WINDOW_HOURS = Number(process.env.WHATSAPP_SERVICE_WINDOW_HOURS || 24);
export const WHATSAPP_DAILY_QUOTA = Number(process.env.WHATSAPP_DAILY_QUOTA || 1000);
export const WHATSAPP_JOB_CONCURRENCY = Number(process.env.WHATSAPP_JOB_CONCURRENCY || 3);
export const MAX_BULK_WHATSAPP_RECIPIENTS = Number(process.env.MAX_BULK_WHATSAPP_RECIPIENTS || 5000);
export const WHATSAPP_REQUEST_TIMEOUT_MS = Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 15000);

export const ARKESEL_WEBHOOK_SECRET = process.env.ARKESEL_WEBHOOK_SECRET;
export const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY;

export const SMS_DEFAULT_PROVIDER = process.env.SMS_DEFAULT_PROVIDER || 'moolre';
export const ARKESEL_API_URL = process.env.ARKESEL_API_URL;
export const ARKESEL_SENDER_ID = process.env.ARKESEL_SENDER_ID;
export const ARKESEL_TIMEOUT_MS = Number(process.env.ARKESEL_TIMEOUT_MS || 15000);
export const ARKESEL_CALLBACK_URL = process.env.ARKESEL_CALLBACK_URL;

export const MTN_ENVIRONMENT = process.env.MTN_ENVIRONMENT || 'sandbox';
const MTN_SANDBOX_BASE = 'https://sandbox.momodeveloper.mtn.com';
const MTN_PRODUCTION_BASE = process.env.MTN_PRODUCTION_BASE_URL || 'https://api.mtn.com';
export const MTN_BASE_URL =
  process.env.MTN_BASE_URL ||
  (MTN_ENVIRONMENT === 'production' ? MTN_PRODUCTION_BASE : MTN_SANDBOX_BASE);

export const MTN_COLLECTION_SUBSCRIPTION_KEY = process.env.MTN_COLLECTION_SUBSCRIPTION_KEY;
export const MTN_DISBURSEMENT_SUBSCRIPTION_KEY = process.env.MTN_DISBURSEMENT_SUBSCRIPTION_KEY;
export const MTN_REMITTANCE_SUBSCRIPTION_KEY = process.env.MTN_REMITTANCE_SUBSCRIPTION_KEY;
export const MTN_API_USER = process.env.MTN_API_USER;
export const MTN_API_KEY = process.env.MTN_API_KEY;
export const MTN_TARGET_ENVIRONMENT = process.env.MTN_TARGET_ENVIRONMENT || MTN_ENVIRONMENT;
export const MTN_TOKEN_PATH = process.env.MTN_TOKEN_PATH || '/token/';
export const MTN_TOKEN_EXPIRY = Number(process.env.MTN_TOKEN_EXPIRY || 3600);
export const MTN_REQUEST_TIMEOUT_MS = Number(process.env.MTN_REQUEST_TIMEOUT_MS || 30000);
export const MTN_CURRENCY = process.env.MTN_CURRENCY || 'GHS';
export const MTN_CALLBACK_HOST = process.env.MTN_CALLBACK_HOST || '';
export const MTN_WEBHOOK_SECRET = process.env.MTN_WEBHOOK_SECRET;
export const PRIMARY_PAYMENT_GATEWAY = process.env.PRIMARY_PAYMENT_GATEWAY || 'moolre';

export const MOOLRE_API_USER = process.env.MOOLRE_API_USER;
export const MOOLRE_API_KEY = process.env.MOOLRE_API_KEY;
export const MOOLRE_PUBLIC_KEY = process.env.MOOLRE_PUBLIC_KEY;
export const MOOLRE_ACCOUNT_NUMBER = process.env.MOOLRE_ACCOUNT_NUMBER;

export const MOOLRE_BASE_URL = process.env.MOOLRE_BASE_URL || 'https://api.moolre.com';
export const MOOLRE_SMS_BASE_URL =
  process.env.MOOLRE_SMS_BASE_URL ||
  (MOOLRE_BASE_URL.includes('sandbox') ? 'https://api.moolre.com' : MOOLRE_BASE_URL);

export const MOOLRE_CHECKOUT_URL =
  process.env.MOOLRE_CHECKOUT_URL ||
  (MOOLRE_BASE_URL.includes('sandbox') ? 'https://sandbox.moolre.com' : 'https://pos.moolre.com');

export const MOOLRE_REQUEST_TIMEOUT_MS = Number(process.env.MOOLRE_REQUEST_TIMEOUT_MS || 30000);

export const MOOLRE_CALLBACK_URL =
  process.env.MOOLRE_CALLBACK_URL || `${WEBHOOK_BASE_URL}/api/pay/webhook/moolre`;

export const MOOLRE_CALLBACK_SECRET = MOOLRE_BASE_URL.includes('sandbox')
  ? process.env.MOOLRE_CALLBACK_SECRET_SANDBOX || process.env.MOOLRE_CALLBACK_SECRET || ''
  : process.env.MOOLRE_CALLBACK_SECRET || '';

export const MOOLRE_VASKEY =
  process.env.MOOLRE_VASKEY || process.env.MOOLRE_SMS_VASKEY || process.env.MOOLRE_WHATSAPP_VASKEY || '';

export const MOOLRE_SMS_VASKEY =
  process.env.MOOLRE_SMS_VASKEY || MOOLRE_VASKEY || '';
export const MOOLRE_SMS_SENDER_ID = process.env.MOOLRE_SMS_SENDER_ID;

export const MOOLRE_WHATSAPP_VASKEY =
  process.env.MOOLRE_WHATSAPP_VASKEY || MOOLRE_VASKEY || '';

export const WEBHOOK_AUTH_ENFORCED =
  process.env.WEBHOOK_AUTH_ENFORCED ?? (NODE_ENV === 'production' ? 'true' : 'false');

export const GHANA_SCHOOLS_API_URL = process.env.GHANA_SCHOOLS_API_URL || '';
export const GHANA_SCHOOLS_API_KEY = process.env.GHANA_SCHOOLS_API_KEY || '';