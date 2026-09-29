import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReplyHtml, htmlToPlainText } from '../src/sanitizeReplyHtml.ts';
import { measureMigaduHold, logMigaduDelay } from '../src/migaduDelay.ts';

test('reply HTML drops tag attributes while preserving readable list numbering', () => {
    const html = sanitizeReplyHtml('<div>Hello <b onclick="run()">team</b><br/></div><ol><li>first</li><li>second</li></ol>');
    assert.equal(html, '<div>Hello <b>team</b><br></div><ol><li>first</li><li>second</li></ol>');
    assert.equal(htmlToPlainText(html), 'Hello team\n1. first\n2. second');
});

test('Migadu timing uses the oldest acceptance header and logs a long hold', () => {
    const source = Buffer.from([
        'Received: from queue by soraStorage1.migadu.com with LMTP; Tue, 29 Sep 2026 10:10:00 +0000',
        'Received: from relay by mizu2.migadu.com with ESMTPS; Tue, 29 Sep 2026 10:00:00 +0000',
        'Received: from sender by mizu1.migadu.com with ESMTPS;',
        ' Tue, 29 Sep 2026 09:59:00 +0000',
        'X-Migadu-Queue-Id: Q123',
        '',
        'Body',
    ].join('\r\n'));
    const hold = measureMigaduHold(source);
    assert.equal(hold?.holdMs, 11 * 60 * 1000);
    assert.equal(hold?.queueId, 'Q123');
    const warning = mock.method(console, 'warn', () => {});
    try {
        logMigaduDelay(hold, { mailbox: 'staff@example.test', messageId: '<m@test>', senderEmail: 'parent@example.test', students: ['student@example.test'] });
        assert.equal(warning.mock.callCount(), 1);
        assert.match(String(warning.mock.calls[0].arguments[0]), /held=11m queue=Q123/);
    } finally {
        warning.mock.restore();
    }
});
