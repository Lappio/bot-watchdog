export interface Env {
  DB: D1Database;
  PUBLIC_BASE_URL: string;
  ALERT_FROM_EMAIL: string;
  ADMIN_TOKEN: string;
  TELEGRAM_BOT_TOKEN?: string;
  RESEND_API_KEY?: string;
}
