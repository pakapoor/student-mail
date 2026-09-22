-- Local dev seed data ONLY — never run against production.
-- Fake students + messages under central_email = the local login mailbox
-- (pankaj@system-design.in, see backend/.env.local), so they show up in the
-- console once logged in locally. No real IMAP sync involved.

INSERT INTO students (email, smtp_password, name, first_name, last_name, college, year_enrolled, central_email, college_id, admission_id, is_test)
VALUES
    ('gupta.abhay@pilot.local', 'unused-dev-password', 'Abhay Gupta', 'Abhay', 'Gupta', 'KSMA CENTRAL', 2026, 'pankaj@system-design.in', 1, NULL, true),
    ('nisha.gupta@pilot.local', 'unused-dev-password', 'Nisha Gupta', 'Nisha', 'Gupta', 'KSMA CENTRAL', 2026, 'pankaj@system-design.in', 1, NULL, true),
    ('rohan.g@pilot.local', 'unused-dev-password', 'Rohan Guptaraman', 'Rohan', 'Guptaraman', 'KSMA CENTRAL', 2025, 'pankaj@system-design.in', 1, NULL, true),
    ('priya.menon@pilot.local', 'unused-dev-password', 'Priya Menon', 'Priya', 'Menon', 'KSMA CENTRAL', 2026, 'pankaj@system-design.in', 1, NULL, true),
    ('rahul.iyer@pilot.local', 'unused-dev-password', 'Rahul Iyer', 'Rahul', 'Iyer', 'KSMA CENTRAL', 2025, 'pankaj@system-design.in', 1, NULL, true),
    -- Admission ID with a literal underscore, to test that search treats "_"
    -- as a literal character rather than a SQL LIKE single-char wildcard.
    ('a_test@pilot.local', 'unused-dev-password', 'A Test', 'A', 'Test', 'KSMA CENTRAL', 2026, 'pankaj@system-design.in', 1, 'A_102', true)
ON CONFLICT (email) DO NOTHING;

-- Pending threads (no reply, no handled flag -> stillPending stays true)
INSERT INTO messages (message_id, student_email, sender_email, subject, received_at, replied, body_text, central_email)
VALUES
    ('msg-abhay-1', 'gupta.abhay@pilot.local', 'registrar@ksma.edu', 'Re: Transcript request follow-up',
     now() - interval '2 hours', false,
     'Hi, just checking on the status of my transcript request from last week.', 'pankaj@system-design.in'),
    ('msg-nisha-1', 'nisha.gupta@pilot.local', 'library@ksma.edu', 'Library card renewal',
     now() - interval '6 hours', false,
     'My library card expired, could you help renew it for this semester?', 'pankaj@system-design.in'),
    ('msg-priya-1', 'priya.menon@pilot.local', 'accounts@ksma.edu', 'Fee receipt not received',
     now() - interval '5 hours', false,
     'I paid the semester fee on the 12th but have not received a receipt yet.', 'pankaj@system-design.in'),
    ('msg-rahul-1', 'rahul.iyer@pilot.local', 'hostel@ksma.edu', 'Hostel allotment query',
     now() - interval '1 day', false,
     'When will hostel room allotments be announced for this semester?', 'pankaj@system-design.in'),
    ('msg-atest-1', 'a_test@pilot.local', 'admissions@ksma.edu', 'Admission ID confirmation',
     now() - interval '1 hour', false,
     'Confirming my admission ID.', 'pankaj@system-design.in')
ON CONFLICT (message_id, student_email) DO NOTHING;

-- One closed thread: message + a reply that resolves it (resolvedAt > received_at)
INSERT INTO messages (message_id, student_email, sender_email, subject, received_at, replied, replied_at, body_text, central_email)
VALUES
    ('msg-rohan-1', 'rohan.g@pilot.local', 'registrar@ksma.edu', 'Bonafide certificate issued',
     now() - interval '3 days', true, now() - interval '3 days' + interval '10 minutes',
     'Could I get a bonafide certificate for my visa application?', 'pankaj@system-design.in')
ON CONFLICT (message_id, student_email) DO NOTHING;

INSERT INTO replies (incoming_message_id, student_email, recipient_email, sent_message_id, sent_at, body_text)
VALUES
    ('msg-rohan-1', 'rohan.g@pilot.local', 'rohan.g@pilot.local', 'reply-rohan-1',
     now() - interval '3 days' + interval '10 minutes',
     E'Sure, I\'ve attached the signed bonafide certificate as requested.')
ON CONFLICT DO NOTHING;
