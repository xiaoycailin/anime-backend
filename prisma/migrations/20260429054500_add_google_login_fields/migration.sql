ALTER TABLE `users`
  ADD COLUMN `login_type` VARCHAR(30) NOT NULL DEFAULT 'email',
  ADD COLUMN `google_id` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `User_google_id_key` ON `users`(`google_id`);
