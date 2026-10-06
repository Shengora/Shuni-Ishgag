const fs = require('fs');
const filepath = 'lib/db/src/schema/admins.ts';
let code = fs.readFileSync(filepath, 'utf8');

if (!code.includes('threeDsMode')) {
  code = code.replace(
    /addedBySuperAdminId:\s*bigint\([^)]+\)(?:, \/\/ null = env seeded)?,\n/m,
    "addedBySuperAdminId: bigint(\"added_by_super_admin_id\", { mode: \"number\" }), // null = env seeded\n  threeDsMode: text(\"three_ds_mode\").notNull().default(\"auto\"),\n"
  );
  fs.writeFileSync(filepath, code);
}
