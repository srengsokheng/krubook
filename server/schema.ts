// Migrations run in order; each one runs once and bumps `schema_meta.version`.
// Dates are ISO `YYYY-MM-DD` (SQLite's date type), times are `HH:MM`, timestamps are UTC datetime().

export const MIGRATIONS: string[] = [
  /* 1: core schema */ `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('admin','teacher')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE settings (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_km TEXT,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#3559c7' CHECK (color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'),
  weeks INTEGER NOT NULL DEFAULT 17 CHECK (weeks BETWEEN 1 AND 40),
  session_rule TEXT NOT NULL DEFAULT '{"mode":"sequence","sequence":["lecture","practice"]}',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, code)
);

CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  objectives TEXT,
  description TEXT,
  est_minutes INTEGER CHECK (est_minutes IS NULL OR est_minutes > 0)
);
CREATE INDEX lessons_course ON lessons(course_id, position);

CREATE TABLE lesson_parts (
  id INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  title TEXT,
  objectives TEXT,
  est_minutes INTEGER CHECK (est_minutes IS NULL OR est_minutes > 0)
);
CREATE INDEX parts_lesson ON lesson_parts(lesson_id, position);

CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  part_id INTEGER REFERENCES lesson_parts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('slides','exercise','code','lab','other')),
  title TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','ready')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX materials_lesson ON materials(lesson_id);

CREATE TABLE template_weeks (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  activity TEXT NOT NULL CHECK (activity IN ('lesson','midterm_review','midterm','capstone','final_review','final','buffer')),
  checkpoint TEXT,
  label TEXT,
  UNIQUE (course_id, week)
);

CREATE TABLE terms (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  midterm_start TEXT, midterm_end TEXT,
  final_start TEXT, final_end TEXT,
  grade_target REAL NOT NULL DEFAULT 100 CHECK (grade_target > 0),
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','completed','archived')),
  cloned_from_id INTEGER REFERENCES terms(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date),
  CHECK (midterm_end IS NULL OR midterm_end >= midterm_start),
  CHECK (final_end IS NULL OR final_end >= final_start)
);

CREATE TABLE holidays (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id INTEGER REFERENCES terms(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  name_km TEXT,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('national','user')),
  approx INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX holidays_unique ON holidays(owner_id, COALESCE(term_id, 0), date);

CREATE TABLE classes (
  id INTEGER PRIMARY KEY,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE RESTRICT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  name TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  room TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','completed','archived')),
  weeks INTEGER NOT NULL DEFAULT 17 CHECK (weeks BETWEEN 1 AND 40),
  session_rule TEXT,
  progress_tolerance INTEGER NOT NULL DEFAULT 0 CHECK (progress_tolerance >= 0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term_id, code),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  room TEXT,
  CHECK (end_time > start_time)
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  gen_key TEXT,
  week INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lecture','practice','exam')),
  kind_source TEXT NOT NULL DEFAULT 'auto' CHECK (kind_source IN ('auto','manual')),
  activity TEXT NOT NULL DEFAULT 'lesson' CHECK (activity IN ('lesson','midterm_review','midterm','capstone','final_review','final','buffer','makeup')),
  part_id INTEGER REFERENCES lesson_parts(id) ON DELETE SET NULL,
  checkpoint TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled','skipped','moved')),
  confirmed INTEGER NOT NULL DEFAULT 0,
  holiday_exception INTEGER NOT NULL DEFAULT 0,
  is_makeup INTEGER NOT NULL DEFAULT 0,
  moved_from_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  original_date TEXT NOT NULL,
  original_part_id INTEGER,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, gen_key),
  CHECK (end_time > start_time)
);
CREATE INDEX sessions_class_date ON sessions(class_id, date, start_time);
CREATE INDEX sessions_date ON sessions(date);

CREATE TABLE teaching_records (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  taught_on TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  pace TEXT NOT NULL DEFAULT 'on_plan' CHECK (pace IN ('on_plan','early','behind')),
  notes TEXT,
  follow_up TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE record_parts (
  record_id INTEGER NOT NULL REFERENCES teaching_records(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES lesson_parts(id) ON DELETE RESTRICT,
  coverage TEXT NOT NULL CHECK (coverage IN ('full','partial')),
  PRIMARY KEY (record_id, part_id)
);

CREATE TABLE schedule_proposals (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed','stale')),
  payload TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  student_code TEXT NOT NULL,
  name_km TEXT,
  name_latin TEXT,
  gender TEXT,
  email TEXT,
  phone TEXT,
  custom TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, student_code),
  CHECK (COALESCE(name_km, name_latin) IS NOT NULL)
);

CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dropped','withdrawn','transferred','completed')),
  enrolled_on TEXT NOT NULL,
  ended_on TEXT,
  transferred_to_id INTEGER REFERENCES enrollments(id),
  note TEXT
);
CREATE UNIQUE INDEX enrollments_one_active ON enrollments(student_id, class_id) WHERE status = 'active';
CREATE INDEX enrollments_class ON enrollments(class_id);

CREATE TABLE grade_configs (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL UNIQUE REFERENCES classes(id) ON DELETE CASCADE,
  target_total REAL NOT NULL DEFAULT 100 CHECK (target_total > 0),
  pass_mark REAL NOT NULL DEFAULT 50 CHECK (pass_mark > 0),
  label_pass TEXT NOT NULL DEFAULT 'ជាប់',
  label_fail TEXT NOT NULL DEFAULT 'ធ្លាក់',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','finalized')),
  attendance_rule TEXT NOT NULL DEFAULT '{"lateCredit":0.5,"excused":"exclude"}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE grade_components (
  id INTEGER PRIMARY KEY,
  config_id INTEGER NOT NULL REFERENCES grade_configs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  max_score REAL NOT NULL CHECK (max_score > 0),
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','attendance')),
  UNIQUE (config_id, key)
);

CREATE TABLE scores (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  component_id INTEGER NOT NULL REFERENCES grade_components(id) ON DELETE RESTRICT,
  value REAL NOT NULL CHECK (value >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (enrollment_id, component_id)
);
CREATE INDEX scores_component ON scores(component_id);

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('present','late','absent','excused')),
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, enrollment_id)
);
CREATE INDEX attendance_enrollment ON attendance(enrollment_id);

CREATE TABLE rates (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('hourly','per_session')),
  amount REAL NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  effective_from TEXT NOT NULL
);

CREATE TABLE pay_adjustments (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  amount REAL NOT NULL,
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  amount REAL NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('confirmed','paid')),
  paid_on TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notification_log (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);

-- Integrity rules enforced in the database, not only in the API.

CREATE TRIGGER scores_within_max_ins BEFORE INSERT ON scores
WHEN NEW.value > (SELECT max_score FROM grade_components WHERE id = NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'SCORE_ABOVE_MAX'); END;

CREATE TRIGGER scores_within_max_upd BEFORE UPDATE OF value ON scores
WHEN NEW.value > (SELECT max_score FROM grade_components WHERE id = NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'SCORE_ABOVE_MAX'); END;

CREATE TRIGGER scores_same_class BEFORE INSERT ON scores
WHEN (SELECT class_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT
     (SELECT gc.class_id FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE c.id = NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'SCORE_WRONG_CLASS'); END;

CREATE TRIGGER scores_not_finalized_ins BEFORE INSERT ON scores
WHEN (SELECT gc.status FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE c.id = NEW.component_id) = 'finalized'
BEGIN SELECT RAISE(ABORT, 'GRADEBOOK_FINALIZED'); END;

CREATE TRIGGER scores_not_finalized_del BEFORE DELETE ON scores
WHEN (SELECT gc.status FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE c.id = OLD.component_id) = 'finalized'
BEGIN SELECT RAISE(ABORT, 'GRADEBOOK_FINALIZED'); END;

CREATE TRIGGER scores_not_finalized BEFORE UPDATE ON scores
WHEN (SELECT gc.status FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE c.id = NEW.component_id) = 'finalized'
BEGIN SELECT RAISE(ABORT, 'GRADEBOOK_FINALIZED'); END;

CREATE TRIGGER components_max_not_below_scores BEFORE UPDATE OF max_score ON grade_components
WHEN EXISTS (SELECT 1 FROM scores WHERE component_id = NEW.id AND value > NEW.max_score)
BEGIN SELECT RAISE(ABORT, 'MAX_BELOW_EXISTING_SCORES'); END;

CREATE TRIGGER grade_config_activation BEFORE UPDATE OF status ON grade_configs
WHEN NEW.status IN ('active','finalized')
 AND round((SELECT COALESCE(SUM(max_score), 0) FROM grade_components WHERE config_id = NEW.id), 2) <> NEW.target_total
BEGIN SELECT RAISE(ABORT, 'GRADE_TOTAL_MISMATCH'); END;

CREATE TRIGGER grade_target_change BEFORE UPDATE OF target_total ON grade_configs
WHEN NEW.status IN ('active','finalized')
 AND round((SELECT COALESCE(SUM(max_score), 0) FROM grade_components WHERE config_id = NEW.id), 2) <> NEW.target_total
BEGIN SELECT RAISE(ABORT, 'GRADE_TOTAL_MISMATCH'); END;

CREATE TRIGGER components_locked_ins BEFORE INSERT ON grade_components
WHEN (SELECT status FROM grade_configs WHERE id = NEW.config_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'CONFIG_NOT_DRAFT'); END;
CREATE TRIGGER components_locked_upd BEFORE UPDATE ON grade_components
WHEN (SELECT status FROM grade_configs WHERE id = NEW.config_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'CONFIG_NOT_DRAFT'); END;
CREATE TRIGGER components_locked_del BEFORE DELETE ON grade_components
WHEN (SELECT status FROM grade_configs WHERE id = OLD.config_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'CONFIG_NOT_DRAFT'); END;

CREATE TRIGGER attendance_valid_ins BEFORE INSERT ON attendance
BEGIN
  SELECT RAISE(ABORT, 'ATTENDANCE_SESSION_NOT_HELD')
   WHERE (SELECT status FROM sessions WHERE id = NEW.session_id) IN ('cancelled','moved','skipped');
  SELECT RAISE(ABORT, 'ATTENDANCE_WRONG_CLASS')
   WHERE (SELECT class_id FROM sessions WHERE id = NEW.session_id) IS NOT (SELECT class_id FROM enrollments WHERE id = NEW.enrollment_id);
END;
CREATE TRIGGER attendance_valid_upd BEFORE UPDATE ON attendance
BEGIN
  SELECT RAISE(ABORT, 'ATTENDANCE_SESSION_NOT_HELD')
   WHERE (SELECT status FROM sessions WHERE id = NEW.session_id) IN ('cancelled','moved','skipped');
END;

CREATE TRIGGER sessions_completed_keep BEFORE DELETE ON sessions
WHEN OLD.status = 'completed' OR EXISTS (SELECT 1 FROM attendance WHERE session_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'SESSION_HAS_HISTORY'); END;

CREATE TRIGGER sessions_cancel_with_attendance BEFORE UPDATE OF status ON sessions
WHEN NEW.status IN ('cancelled','skipped','moved') AND EXISTS (SELECT 1 FROM attendance WHERE session_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'SESSION_HAS_ATTENDANCE'); END;
`,
];
