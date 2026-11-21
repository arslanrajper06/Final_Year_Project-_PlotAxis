CREATE DATABASE IF NOT EXISTS plotaxis_db;
USE plotaxis_db;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  phone VARCHAR(30) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_verified TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(150) NOT NULL,
  otp_code VARCHAR(10) NOT NULL,
  purpose ENUM('register', 'login') NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plot_reservations (
  booking_id VARCHAR(100) PRIMARY KEY,
  user_id INT NOT NULL,
  plot_id VARCHAR(30) NOT NULL,
  booking_data JSON NOT NULL,
  status ENUM('pending', 'payment_verified', 'cancelled') NOT NULL DEFAULT 'pending',
  reserved_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  extension_used TINYINT(1) NOT NULL DEFAULT 0,
  payment_verified_at DATETIME(3) NULL,
  cancel_at DATETIME(3) NULL,
  cancellation_reason ENUM('customer', 'expiry') NULL,
  cancelled_at DATETIME(3) NULL,
  reminder_24_sent_at DATETIME(3) NULL,
  reminder_48_sent_at DATETIME(3) NULL,
  expiry_notice_sent_at DATETIME(3) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_plot_reservations_plot_status (plot_id, status, expires_at),
  INDEX idx_plot_reservations_due (status, expires_at),
  CONSTRAINT fk_plot_reservations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS certificate_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  society_name VARCHAR(120) NOT NULL,
  document_type ENUM('society_registration', 'noc', 'approved_layout_plan', 'land_ownership') NOT NULL,
  title VARCHAR(180) NOT NULL,
  issuing_authority VARCHAR(180) NOT NULL,
  approval_number VARCHAR(120) NOT NULL,
  verification_status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(1000) NULL,
  file_name VARCHAR(180) NULL,
  mime_type ENUM('application/pdf', 'image/png', 'image/jpeg') NULL,
  file_data LONGBLOB NULL,
  uploaded_by VARCHAR(100) NOT NULL,
  reviewed_by VARCHAR(100) NULL,
  reviewed_at DATETIME(3) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_certificate_documents_status_society (verification_status, society_name)
);

CREATE TABLE IF NOT EXISTS certificate_views (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  certificate_id INT NOT NULL,
  customer_id INT NULL,
  viewer_type ENUM('customer', 'admin') NOT NULL,
  admin_name VARCHAR(100) NULL,
  viewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(512) NULL,
  INDEX idx_certificate_views_document_time (certificate_id, viewed_at),
  INDEX idx_certificate_views_customer_time (customer_id, viewed_at),
  CONSTRAINT fk_certificate_views_document FOREIGN KEY (certificate_id) REFERENCES certificate_documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_certificate_views_customer FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL
);
