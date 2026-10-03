import bcrypt from 'bcryptjs';

const pw = process.argv[2];
if (!pw) { console.error('Usage: npm run hash -- "your admin password"'); process.exit(1); }
console.log(bcrypt.hashSync(pw, 12));
