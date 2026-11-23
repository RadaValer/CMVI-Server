-- Schema bazei de date (MySQL 5.7+ / MariaDB 10.3+).
-- Se creează automat la prima pornire din /admin (configurarea inițială) sau cu "npm run populate".

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('elev','profesor','admin') NOT NULL,
  class_name VARCHAR(60) NULL,
  teacher_code VARCHAR(30) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME NULL,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sesiunile de autentificare: tokenul trimis de browser în antetul Authorization (aici doar hash-ul lui).
-- "site" = contul de pe site, "admin" = panoul /admin (autentificări separate).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  scope ENUM('site','admin') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  KEY ix_sessions_exp (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS news (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  published_on DATE NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_news_date (published_on),
  CONSTRAINT fk_news_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fișierele încărcate din /admin sunt ținute în baza de date (serverele gratuite nu au disc permanent).
CREATE TABLE IF NOT EXISTS files (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mime VARCHAR(100) NOT NULL,
  size INT UNSIGNED NOT NULL,
  data LONGBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- path = fișier din client (ex. "assets/doc-1.jpg", pentru anunțurile vechi); file_id = fișier încărcat (tabela files)
CREATE TABLE IF NOT EXISTS news_files (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  news_id INT UNSIGNED NOT NULL,
  kind ENUM('image','file') NOT NULL,
  path VARCHAR(255) NOT NULL DEFAULT '',
  file_id INT UNSIGNED NULL,
  name VARCHAR(255) NOT NULL,
  sort INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_files_news FOREIGN KEY (news_id) REFERENCES news(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tt_periods (
  period INT NOT NULL PRIMARY KEY,
  start_time VARCHAR(10) NOT NULL DEFAULT '',
  end_time VARCHAR(10) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tt_classes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  level VARCHAR(20) NOT NULL,
  grade VARCHAR(10) NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Profesorii: se adaugă din /admin (fila Profesori) și automat la importul orarului.
-- Importul nu șterge niciodată un profesor; codul este cel din orar (ex. "PD").
CREATE TABLE IF NOT EXISTS teachers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_teachers_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tt_subjects (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tt_rooms (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tt_entries (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  class_name VARCHAR(60) NOT NULL,
  day TINYINT NOT NULL,
  period INT NOT NULL,
  subject VARCHAR(40) NOT NULL,
  teachers VARCHAR(160) NOT NULL DEFAULT '',
  room VARCHAR(80) NOT NULL DEFAULT '',
  grp VARCHAR(80) NOT NULL DEFAULT '',
  KEY ix_tt_class (class_name),
  KEY ix_tt_slot (day, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS substitutions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sub_date DATE NOT NULL,
  period INT NOT NULL,
  class_name VARCHAR(60) NOT NULL,
  absent_code VARCHAR(30) NOT NULL DEFAULT '',
  absent_name VARCHAR(120) NOT NULL,
  substitute_code VARCHAR(30) NOT NULL DEFAULT '',
  substitute_name VARCHAR(120) NOT NULL,
  subject VARCHAR(160) NOT NULL DEFAULT '',
  room VARCHAR(80) NOT NULL DEFAULT '',
  note VARCHAR(255) NOT NULL DEFAULT '',
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_subs_date (sub_date),
  CONSTRAINT fk_subs_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Setări și conținut editabil: datele de contact ('school'), organizarea ('organization'), linkurile din „Altele” ('links'), date despre orar.
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(50) NOT NULL PRIMARY KEY,
  v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(45) NOT NULL,
  at DATETIME NOT NULL,
  KEY ix_attempts (ip, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
