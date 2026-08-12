import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config, assertProviderConfigured } from './config.js';
import { SqliteRepository, newId } from './db/sqlite.js';
import { getProvider } from './providers/index.js';
import { CampaignService } from './service/campaign.js';
import { ChatHandler } from './service/chat.js';
import { buildCard } from './render/card.js';
import { startRefreshJob } from './jobs/refresh.js';
import { toCsv } from './export/csv.js';

/**
 * Reference HTTP server.
 *
 * This exists so the flow can be exercised end to end before any of it is
 * built into the app. It is NOT meant to ship: identity comes from a header,
 * and admin status comes from an env var. See docs/04-api-contracts.md for the
 * contracts the real implementation should honour.
 */

assertProviderConfigured();

const repo = new SqliteRepository(config.databasePath);
const provider = getProvider();
const service = new CampaignService(repo, provider);
const chat = new ChatHandler(service, { bareUrlSubmits: false });

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Identity (reference only)
// ---------------------------------------------------------------------------

interface Caller {
  userId: string;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller: Caller;
    }
  }
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const userId = req.header('x-user-id');
  if (!userId) {
    res.status(401).json({ error: 'Missing X-User-Id header' });
    return;
  }
  req.caller = { userId, isAdmin: config.adminUserIds.includes(userId) };
  next();
});

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const createCampaignSchema = z.object({
  chatId: z.string().min(1),
  name: z.string().min(1),
  startsAt: z.number().int().optional(),
  endsAt: z.number().int().nullable().optional(),
  minViews: z.number().int().min(0).optional(),
});

app.post(
  '/campaigns',
  asyncRoute(async (req, res) => {
    if (!req.caller.isAdmin) {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    const campaign = await repo.createCampaign({
      id: newId('camp'),
      chatId: parsed.data.chatId,
      name: parsed.data.name,
      startsAt: parsed.data.startsAt ?? Math.floor(Date.now() / 1000),
      endsAt: parsed.data.endsAt ?? null,
      minViews: parsed.data.minViews ?? 0,
      active: true,
    });
    res.status(201).json(campaign);
  }),
);

app.get(
  '/campaigns/by-chat/:chatId',
  asyncRoute(async (req, res) => {
    const campaign = await repo.getActiveCampaignForChat(req.params.chatId!);
    if (!campaign) {
      res.status(404).json({ error: 'No active campaign for that chat' });
      return;
    }
    res.json(campaign);
  }),
);

// ---------------------------------------------------------------------------
// Chat message ingress — the main integration surface
// ---------------------------------------------------------------------------

const messageSchema = z.object({
  chatId: z.string().min(1),
  text: z.string(),
  messageId: z.string().nullable().optional(),
  displayName: z.string().optional(),
});

app.post(
  '/chat/messages',
  asyncRoute(async (req, res) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    const responses = await chat.handleMessage(parsed.data.text, {
      chatId: parsed.data.chatId,
      userId: req.caller.userId,
      messageId: parsed.data.messageId ?? null,
      isAdmin: req.caller.isAdmin,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
    });

    res.json({ responses });
  }),
);

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

app.get(
  '/campaigns/:campaignId/submissions',
  asyncRoute(async (req, res) => {
    const status = req.query.status as 'pending' | 'approved' | 'declined' | undefined;
    const submissions = await repo.listSubmissions({
      campaignId: req.params.campaignId!,
      ...(status ? { status } : {}),
      limit: Number(req.query.limit ?? 50),
      offset: Number(req.query.offset ?? 0),
    });

    res.json({
      submissions,
      cards: submissions.map((submission) =>
        buildCard(submission, {
          viewerIsAdmin: req.caller.isAdmin,
          viewerUserId: req.caller.userId,
        }),
      ),
    });
  }),
);

app.get(
  '/submissions/:id',
  asyncRoute(async (req, res) => {
    const submission = await repo.getSubmission(req.params.id!);
    if (!submission) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({
      submission,
      card: buildCard(submission, {
        viewerIsAdmin: req.caller.isAdmin,
        viewerUserId: req.caller.userId,
      }),
      snapshots: await repo.listSnapshots(submission.id),
    });
  }),
);

const decisionSchema = z.object({
  action: z.enum(['approve', 'decline', 'reopen']),
  reason: z.string().max(500).nullable().optional(),
});

app.post(
  '/submissions/:id/decision',
  asyncRoute(async (req, res) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    const result = await service.decide({
      submissionId: req.params.id!,
      actor: req.caller,
      action: parsed.data.action,
      reason: parsed.data.reason ?? null,
    });

    if (!result.ok) {
      const status =
        result.code === 'NOT_FOUND' ? 404 : result.code === 'NOT_ADMIN' ? 403 : 409;
      res.status(status).json({ error: result.message, code: result.code });
      return;
    }

    res.json({
      submission: result.submission,
      card: buildCard(result.submission, {
        viewerIsAdmin: req.caller.isAdmin,
        viewerUserId: req.caller.userId,
      }),
    });
  }),
);

app.post(
  '/submissions/:id/refresh',
  asyncRoute(async (req, res) => {
    const submission = await repo.getSubmission(req.params.id!);
    if (!submission) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const metrics = await service.refreshOne(submission);
    if (!metrics) {
      res.status(502).json({ error: 'Could not read metrics for that post' });
      return;
    }
    res.json({ metrics, submission: await repo.getSubmission(submission.id) });
  }),
);

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

app.get(
  '/campaigns/:campaignId/leaderboard',
  asyncRoute(async (req, res) => {
    res.json({ rows: await repo.leaderboard(req.params.campaignId!, Number(req.query.limit ?? 25)) });
  }),
);

/** The approved log, as a spreadsheet. This is the "logged somewhere" output. */
app.get(
  '/campaigns/:campaignId/export.csv',
  asyncRoute(async (req, res) => {
    if (!req.caller.isAdmin) {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    const submissions = await repo.listSubmissions({
      campaignId: req.params.campaignId!,
      status: 'approved',
      limit: 10_000,
    });
    res.header('content-type', 'text/csv; charset=utf-8');
    res.header('content-disposition', 'attachment; filename="approved-clips.csv"');
    res.send(toCsv(submissions));
  }),
);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, provider: provider.name });
});

// ---------------------------------------------------------------------------

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] unhandled error', error);
  res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(config.port, () => {
  console.log(`Clip campaign reference server on http://localhost:${config.port}`);
  console.log(`  provider : ${provider.name}`);
  console.log(`  database : ${config.databasePath}`);
  console.log(`  admins   : ${config.adminUserIds.join(', ') || '(none configured)'}`);
});

const stopRefresh = startRefreshJob(service);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopRefresh();
    server.close(() => {
      void repo.close().then(() => process.exit(0));
    });
  });
}
