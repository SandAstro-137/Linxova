// Email sending client. Supports three providers, checked in order:
//   1. SENDGRID_API_KEY  (@sendgrid/mail HTTP API — authenticated domain,
//      e.g. em4731.linxova.com, must be verified via SendGrid Sender Auth)
//   2. RESEND_API_KEY    (Resend HTTP API)
//   3. Replit connector  (fallback when deployed on Replit)
import { Resend } from 'resend';
import sgMail from '@sendgrid/mail';

function getSendGridCredentials() {
  if (process.env.SENDGRID_API_KEY) {
    return {
      apiKey: process.env.SENDGRID_API_KEY,
      fromEmail: process.env.SENDGRID_FROM_EMAIL || 'noreply@linxova.com',
    };
  }
  return null;
}

let connectionSettings: any;

async function getResendCredentials() {
  // Preferred path: a standard RESEND_API_KEY provided via environment
  // (replit_connectors / connector secrets, a real .env, or shell env).
  if (process.env.RESEND_API_KEY) {
    return {
      apiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.RESEND_FROM_EMAIL || connectionSettings?.settings?.from_email || 'noreply@linxova.com',
    };
  }

  // Replit connector fallback (only works when deployed on Replit with the
  // Resend connector installed).
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken || !hostname) {
    throw new Error('SENDGRID_API_KEY/RESEND_API_KEY not set and no Replit connector available');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=resend',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.api_key)) {
    throw new Error('Resend not connected');
  }
  return { apiKey: connectionSettings.settings.api_key, fromEmail: connectionSettings.settings.from_email };
}

// WARNING: Never cache the Resend client.
// Access tokens expire, so a new client must be created each time.
export async function getResendClient() {
  const { apiKey, fromEmail } = await getResendCredentials();
  return {
    client: new Resend(apiKey),
    fromEmail: fromEmail || 'noreply@linxova.com'
  };
}

export async function sendVerificationEmail(toEmail: string, verificationToken: string, username: string) {
  const appUrl = process.env.APP_BASE_URL
    || (process.env.REPLIT_DEPLOYMENT_URL ? 'https://linxova.co' : null)
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
    || 'http://localhost:5000';

  const verificationUrl = `${appUrl}/verify-email?token=${verificationToken}`;
  const subject = 'Verify your email address - Linxova';
  const html = `<!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5; margin: 0; padding: 40px 20px;">
          <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <h1 style="color: #18181b; font-size: 24px; margin: 0 0 16px;">Verify your email address</h1>
            <p style="color: #52525b; font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
              Hi ${username},
            </p>
            <p style="color: #52525b; font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
              You requested to change your email address on Linxova. Click the button below to verify this email address:
            </p>
            <a href="${verificationUrl}" style="display: inline-block; background-color: #2563eb; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500; font-size: 16px;">
              Verify Email Address
            </a>
            <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 24px 0 0;">
              This link will expire in 24 hours. If you didn't request this change, you can safely ignore this email.
            </p>
            <hr style="border: none; border-top: 1px solid #e4e4e7; margin: 32px 0;">
            <p style="color: #a1a1aa; font-size: 12px; margin: 0;">
              Linxova - Professional Freelancer Marketplace
            </p>
          </div>
        </body>
      </html>`;

  // Provider 1: SendGrid (authenticated domain via CNAMEs you add at your
  // registrar — em4731.linxova.com, domainkeys, dmarc, link branding).
  const sg = getSendGridCredentials();
  if (sg) {
    sgMail.setApiKey(sg.apiKey);
    try {
      const [resp] = await sgMail.send({
        from: sg.fromEmail,
        to: toEmail,
        replyTo: 'support@linxova.com',
        subject,
        html,
      });
      return resp;
    } catch (err: any) {
      const detail = err?.response?.body || err?.message || err;
      console.error('SendGrid send failed:', detail);
      throw new Error('Failed to send verification email (SendGrid)');
    }
  }

  // Provider 2: Resend
  const { client, fromEmail } = await getResendClient();
  const { data, error } = await client.emails.send({
    from: fromEmail,
    to: toEmail,
    replyTo: 'support@linxova.com',
    subject,
    html,
  });

  if (error) {
    console.error('Failed to send verification email:', error);
    throw new Error('Failed to send verification email');
  }

  return data;
}
