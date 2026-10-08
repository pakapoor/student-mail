// The reviewer's note shown on rejected list rows comes from classifyEdugate
// (shared/edugate.ts). The WhatsApp contact sentence must be cut whether or not
// the email writes a colon after "WhatsApp at".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEdugate } from '../../shared/edugate.ts';

const rejection = (note) =>
    `\n--------------------\n\nHello, Anuj Patil!\n\n❌ DOCUMENT REJECTED\n\nDocument: Medical certificate\n\n${note}\n\nReviewed by: Reviewer, 08.10.2026 09:20\n`;

const noteOf = (note) => {
    const info = classifyEdugate('notify@edu.gov.kg', rejection(note), 'anuj@example.test');
    assert.equal(info?.kind, 'rejected');
    return info.note;
};

const REASON = 'The name provided does not match the name stated in your documents.';

test('WhatsApp sentence is cut when written without a colon', () => {
    assert.equal(noteOf(`${REASON} If you have any questions, please contact us via WhatsApp at +996 755 979 827.`), REASON);
});

test('WhatsApp sentence is still cut when written with a colon', () => {
    assert.equal(noteOf(`${REASON} If you have any questions, please contact us via WhatsApp at: +996 755 979 827.`), REASON);
});

test('a note with no real words gives no reason', () => {
    assert.equal(noteOf('1'), null);
});
