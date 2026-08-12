/**
 * Seeds a demo campaign so the server has something to show.
 *
 *   VIEW_PROVIDER=mock npm run seed
 *
 * Creates a campaign in chat `demo_chat`, claims handles for three users, and
 * files a spread of submissions — clean, handle-mismatched, and unverifiable —
 * so every branch of the admin card is visible without touching the live API.
 */

import { config } from '../config.js';
import { SqliteRepository, newId } from '../db/sqlite.js';
import { MockProvider } from '../providers/mock.js';
import { CampaignService } from '../service/campaign.js';

const repo = new SqliteRepository(config.databasePath);

const provider = new MockProvider()
  .setMetrics('7463250363559218474', { views: 1_856_732, authorHandle: 'alice_makes' })
  .setMetrics('7401119988776655443', { views: 12_431, authorHandle: 'alice_makes' })
  .setMetrics('7399988877766655544', { views: 88_204, authorHandle: 'someone_else' })
  .setFailure('7300000000000000001', 'PRIVATE_OR_RESTRICTED');

const service = new CampaignService(repo, provider);

const chatId = 'demo_chat';

const existing = await repo.getActiveCampaignForChat(chatId);
if (existing) {
  console.log(`Campaign already exists for ${chatId}: ${existing.id}`);
  console.log('Delete the database file to start over:', config.databasePath);
  await repo.close();
  process.exit(0);
}

const campaign = await repo.createCampaign({
  id: newId('camp'),
  chatId,
  name: 'Hype Creator Push',
  startsAt: Math.floor(Date.now() / 1000) - 7 * 86_400,
  endsAt: null,
  minViews: 1_000,
  active: true,
});
console.log(`campaign ${campaign.id} (${campaign.name})`);

await service.claimHandle({ userId: 'user_alice', platform: 'tiktok', handle: 'alice_makes' });
await service.claimHandle({ userId: 'user_bob', platform: 'tiktok', handle: 'bob_clips' });

const fixtures = [
  { userId: 'user_alice', url: 'https://www.tiktok.com/@alice_makes/video/7463250363559218474', note: 'clean, high views' },
  { userId: 'user_alice', url: 'https://www.tiktok.com/@alice_makes/video/7401119988776655443', note: 'clean, modest views' },
  { userId: 'user_bob', url: 'https://www.tiktok.com/@someone_else/video/7399988877766655544', note: 'HANDLE_MISMATCH' },
  { userId: 'user_carol', url: 'https://www.tiktok.com/@carol_c/video/7300000000000000001', note: 'metrics unavailable' },
];

for (const fixture of fixtures) {
  const result = await service.submit({
    chatId,
    userId: fixture.userId,
    messageId: newId('msg'),
    url: fixture.url,
  });
  if (result.ok) {
    console.log(
      `  ${result.submission.id}  ${fixture.userId.padEnd(11)} ` +
        `views=${String(result.submission.latestViews ?? '—').padStart(9)} ` +
        `flags=[${result.submission.flags.join(',')}]  (${fixture.note})`,
    );
  } else {
    console.log(`  FAILED ${fixture.userId}: ${result.code} — ${result.message}`);
  }
}

console.log('');
console.log('Start the server and review the queue:');
console.log(`  VIEW_PROVIDER=mock ADMIN_USER_IDS=admin_1 npm start`);
console.log(`  curl -H 'X-User-Id: admin_1' localhost:${config.port}/campaigns/${campaign.id}/submissions?status=pending`);

await repo.close();
