CREATE TABLE issuance_actions (
	id INTEGER PRIMARY KEY,
	actor TEXT NOT NULL,
	type TEXT NOT NULL,
	reason TEXT NOT NULL,
	idempotency_key TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
);

CREATE TRIGGER issuance_actions_immutable_update
BEFORE UPDATE ON issuance_actions
BEGIN
	SELECT RAISE(ABORT, 'issuance actions are immutable');
END;

CREATE TRIGGER issuance_actions_immutable_delete
BEFORE DELETE ON issuance_actions
BEGIN
	SELECT RAISE(ABORT, 'issuance actions are immutable');
END;

CREATE TABLE label_sequence (
	name TEXT PRIMARY KEY CHECK (name = 'issued_labels'),
	next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
);

INSERT INTO label_sequence (name, next_sequence) VALUES ('issued_labels', 1);

CREATE TABLE issued_labels (
	id INTEGER PRIMARY KEY,
	action_id INTEGER NOT NULL UNIQUE REFERENCES issuance_actions(id),
	sequence INTEGER UNIQUE,
	ver INTEGER NOT NULL CHECK (ver = 1),
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	cid TEXT,
	val TEXT NOT NULL,
	neg INTEGER NOT NULL DEFAULT 0 CHECK (neg IN (0, 1)),
	cts TEXT NOT NULL,
	exp TEXT,
	sig BLOB NOT NULL,
	signing_key_id TEXT NOT NULL
);

CREATE TRIGGER issued_labels_allocate_sequence
AFTER INSERT ON issued_labels
BEGIN
	UPDATE issued_labels
	SET sequence = (SELECT next_sequence FROM label_sequence WHERE name = 'issued_labels')
	WHERE id = NEW.id;
	UPDATE label_sequence SET next_sequence = next_sequence + 1 WHERE name = 'issued_labels';
END;

CREATE TRIGGER issued_labels_immutable_update
BEFORE UPDATE ON issued_labels
WHEN NEW.sequence IS NULL
  OR (OLD.sequence IS NOT NULL AND OLD.sequence IS NOT NEW.sequence)
  OR OLD.id IS NOT NEW.id
  OR OLD.action_id IS NOT NEW.action_id
  OR OLD.ver IS NOT NEW.ver
  OR OLD.src IS NOT NEW.src
  OR OLD.uri IS NOT NEW.uri
  OR OLD.cid IS NOT NEW.cid
  OR OLD.val IS NOT NEW.val
  OR OLD.neg IS NOT NEW.neg
  OR OLD.cts IS NOT NEW.cts
  OR OLD.exp IS NOT NEW.exp
BEGIN
	SELECT RAISE(ABORT, 'issued labels are immutable');
END;

CREATE TRIGGER issued_labels_immutable_delete
BEFORE DELETE ON issued_labels
BEGIN
	SELECT RAISE(ABORT, 'issued labels are immutable');
END;

CREATE INDEX issued_labels_query_order ON issued_labels(sequence);
CREATE INDEX issued_labels_uri_sequence ON issued_labels(uri, sequence);
CREATE INDEX issued_labels_source_sequence ON issued_labels(src, sequence);
