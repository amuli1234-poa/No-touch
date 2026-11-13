import { Router, type Request, type Response } from 'express';
import type { AuthedRequest } from '../lib/session.js';

/**
 * WhatsApp alert dispatch.
 *
 *   GET  /api/whatsapp/status  -> whether a provider is configured (masked)
 *   POST /api/whatsapp/send    -> dispatch a signal alert (session required)
 *
 * The provider credentials live only in the server environment; the browser
 * never sees a token or the raw recipient. The status endpoint intentionally
 * reports only a masked recipient and the names of any missing fields so the
 * settings UI can guide configuration without leaking secrets.
 */

interface WhatsAppConfig {
  configured: boolean;
  provider: 'meta' | 'twilio' | 'callmebot' | 'webhook' | null;
  recipientMasked: string | null;
  missingFields: string[];
}

function maskPhoneOrTarget(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-3)}`;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export function resolveWhatsAppConfig(): WhatsAppConfig {
  const explicitProvider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase().trim();
  const recipient = env('WHATSAPP_RECIPIENT');

  const metaId = env('WHATSAPP_PHONE_NUMBER_ID');
  const metaToken = env('WHATSAPP_ACCESS_TOKEN');
  const twilioSid = env('TWILIO_ACCOUNT_SID');
  const twilioToken = env('TWILIO_AUTH_TOKEN');
  const twilioFrom = env('TWILIO_WHATSAPP_FROM');
  const callMeBotKey = env('CALLMEBOT_API_KEY');
  const webhookUrl = env('WHATSAPP_WEBHOOK_URL');

  if (explicitProvider === 'meta' || (!explicitProvider && metaId && metaToken && recipient)) {
    const missing: string[] = [];
    if (!metaId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
    if (!metaToken) missing.push('WHATSAPP_ACCESS_TOKEN');
    if (!recipient) missing.push('WHATSAPP_RECIPIENT');
    return { configured: missing.length === 0, provider: 'meta', recipientMasked: maskPhoneOrTarget(recipient), missingFields: missing };
  }

  if (explicitProvider === 'twilio' || (!explicitProvider && twilioSid && twilioToken && twilioFrom && recipient)) {
    const missing: string[] = [];
    if (!twilioSid) missing.push('TWILIO_ACCOUNT_SID');
    if (!twilioToken) missing.push('TWILIO_AUTH_TOKEN');
    if (!twilioFrom) missing.push('TWILIO_WHATSAPP_FROM');
    if (!recipient) missing.push('WHATSAPP_RECIPIENT');
    return { configured: missing.length === 0, provider: 'twilio', recipientMasked: maskPhoneOrTarget(recipient), missingFields: missing };
  }

  if (explicitProvider === 'callmebot' || (!explicitProvider && callMeBotKey && recipient)) {
    const missing: string[] = [];
    if (!callMeBotKey) missing.push('CALLMEBOT_API_KEY');
    if (!recipient) missing.push('WHATSAPP_RECIPIENT');
    return { configured: missing.length === 0, provider: 'callmebot', recipientMasked: maskPhoneOrTarget(recipient), missingFields: missing };
  }

  if (explicitProvider === 'webhook' || (!explicitProvider && webhookUrl)) {
    const missing: string[] = [];
    if (!webhookUrl) missing.push('WHATSAPP_WEBHOOK_URL');
    return { configured: missing.length === 0, provider: 'webhook', recipientMasked: maskPhoneOrTarget(recipient || webhookUrl), missingFields: missing };
  }

  return {
    configured: false,
    provider: null,
    recipientMasked: null,
    missingFields: [
      'WHATSAPP_PROVIDER (meta | twilio | callmebot | webhook)',
      'WHATSAPP_RECIPIENT',
      'Provider credentials (e.g. WHATSAPP_ACCESS_TOKEN & WHATSAPP_PHONE_NUMBER_ID)'
    ]
  };
}

async function dispatchWhatsAppMessage(
  message: string,
  metadata?: Record<string, unknown>
): Promise<{ sent: boolean; provider: string | null; messageId?: string; error?: string }> {
  const cfg = resolveWhatsAppConfig();
  if (!cfg.configured || !cfg.provider) {
    return { sent: false, provider: cfg.provider, error: `WhatsApp provider not configured. Missing: ${cfg.missingFields.join(', ')}` };
  }

  const recipient = env('WHATSAPP_RECIPIENT') || '';

  try {
    if (cfg.provider === 'meta') {
      const phoneId = env('WHATSAPP_PHONE_NUMBER_ID')!;
      const token = env('WHATSAPP_ACCESS_TOKEN')!;
      const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient.replace(/[^\d]/g, ''),
          type: 'text',
          text: { body: message }
        })
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok) return { sent: false, provider: 'meta', error: json?.error?.message || `Meta API HTTP ${resp.status}` };
      return { sent: true, provider: 'meta', messageId: json?.messages?.[0]?.id };
    }

    if (cfg.provider === 'twilio') {
      const sid = env('TWILIO_ACCOUNT_SID')!;
      const token = env('TWILIO_AUTH_TOKEN')!;
      const from = env('TWILIO_WHATSAPP_FROM')!;
      const toFormatted = recipient.startsWith('whatsapp:') ? recipient : `whatsapp:${recipient}`;
      const fromFormatted = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
      const form = new URLSearchParams({ To: toFormatted, From: fromFormatted, Body: message });
      const authHeader = Buffer.from(`${sid}:${token}`).toString('base64');
      const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok) return { sent: false, provider: 'twilio', error: json?.message || `Twilio API HTTP ${resp.status}` };
      return { sent: true, provider: 'twilio', messageId: json?.sid };
    }

    if (cfg.provider === 'callmebot') {
      const apiKey = env('CALLMEBOT_API_KEY')!;
      const phone = recipient.replace(/[^\d+]/g, '');
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url);
      const text = await resp.text();
      if (!resp.ok || text.toLowerCase().includes('error')) {
        return { sent: false, provider: 'callmebot', error: text || `CallMeBot HTTP ${resp.status}` };
      }
      return { sent: true, provider: 'callmebot', messageId: `cmb_${Date.now()}` };
    }

    if (cfg.provider === 'webhook') {
      const webhookUrl = env('WHATSAPP_WEBHOOK_URL')!;
      const secret = env('WHATSAPP_WEBHOOK_SECRET');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secret) headers['X-Webhook-Secret'] = secret;
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ recipient: recipient || undefined, message, metadata, timestamp: new Date().toISOString() })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { sent: false, provider: 'webhook', error: text || `Webhook HTTP ${resp.status}` };
      }
      return { sent: true, provider: 'webhook', messageId: `wh_${Date.now()}` };
    }

    return { sent: false, provider: null, error: 'Unsupported WhatsApp provider.' };
  } catch (err: any) {
    return { sent: false, provider: cfg.provider, error: err?.message || 'Network failure while dispatching WhatsApp message.' };
  }
}

export function createWhatsAppRouter(): Router {
  const router = Router();

  router.get('/api/whatsapp/status', (_req: Request, res: Response) => {
    res.json(resolveWhatsAppConfig());
  });

  router.post('/api/whatsapp/send', async (req: AuthedRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ sent: false, error: 'Session required.' });
      return;
    }
    const { message, metadata } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ sent: false, error: 'Message body is required.' });
      return;
    }
    const result = await dispatchWhatsAppMessage(message.trim(), metadata);
    if (!result.sent) {
      const cfgStatus = resolveWhatsAppConfig();
      res.status(cfgStatus.configured ? 502 : 503).json(result);
      return;
    }
    res.json(result);
  });

  return router;
}
