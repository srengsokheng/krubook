// Account management on the server. There is no public sign-up, so this is how accounts are made.
//
//   krubook-user list
//   krubook-user add <email> <name…>     creates an administrator (or claims imported data)
//   krubook-user passwd <email>           sets a new password and signs out that account everywhere
//
// Passwords are typed at a hidden prompt, never passed as arguments (they would land in shell history).
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { DB, AppError } from './db.ts';
import { addAccount, setPassword } from './auth.ts';

function askHidden(question: string): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as any)._writeToOutput?.bind(rl);
    (rl as any)._writeToOutput = (s: string) => { if (s.startsWith(question)) write?.(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); done(answer); });
  });
}

async function newPassword(): Promise<string> {
  const a = await askHidden('New password (at least 8 characters): ');
  const b = await askHidden('Type it again: ');
  if (a !== b) throw new AppError(422, 'The two passwords do not match.');
  return a;
}

async function main() {
  const [cmd, email, ...nameParts] = process.argv.slice(2);
  const db = new DB(resolve(process.env.KRUBOOK_DB ?? 'data/krubook.sqlite'));
  try {
    if (cmd === 'list') {
      for (const u of db.all("SELECT id, email, name, role, password_hash = '!' AS unclaimed FROM users ORDER BY id")) console.log(`${u.id}\t${u.email}\t${u.name}\t${u.role}${u.unclaimed ? '\t(unclaimed: imported data waiting for an owner)' : ''}`);
    } else if (cmd === 'add' && email && nameParts.length) {
      const id = addAccount(db, email, nameParts.join(' '), await newPassword());
      console.log(`Account ${email} is ready (id ${id}). Sign in at the website.`);
    } else if (cmd === 'passwd' && email) {
      setPassword(db, email, await newPassword());
      console.log(`Password changed for ${email}. Existing sign-ins were ended.`);
    } else {
      console.log('Usage:\n  krubook-user list\n  krubook-user add <email> <name>\n  krubook-user passwd <email>');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e instanceof AppError ? e.message : e);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
