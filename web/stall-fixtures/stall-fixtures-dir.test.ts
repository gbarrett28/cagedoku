import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { solve } from '../src/engine/index.js';
import type { StallFixtureFile } from '../src/engine/rules/stallFixtureFile.js';

const fixturesDir = path.resolve(import.meta.dirname, '.');

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.stall.json'));

if (fixtureFiles.length === 0) {
  describe('stall-fixtures', () => {
    it('no fixtures committed yet — nothing to regress', () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe('stall-fixtures', () => {
    for (const filename of fixtureFiles) {
      const filePath = path.join(fixturesDir, filename);
      const fixture = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StallFixtureFile;

      it(`${fixture.name} still requires backtracking`, () => {
        const result = solve(fixture.spec);

        if (!result.usedBacktracking) {
          fs.unlinkSync(filePath);
          expect.fail(
            `${fixture.name} now solves without backtracking — fixture deleted. Commit the deletion.`,
          );
        }

        expect(result.usedBacktracking).toBe(true);
      });
    }
  });
}
