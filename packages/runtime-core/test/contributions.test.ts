// Contribution keys and staging.

import { contributionKey } from '../src/contributions.js';
import { StagedContributions } from '../src/contributions.js';
import { isMoltError } from '../src/errors.js';

describe('contributionKey factory', () => {
  it('creates a frozen key', () => {
    const key = contributionKey<{ id: string }>('test.ui.widget');
    expect(key.id).toBe('test.ui.widget');
    expect(Object.isFrozen(key)).toBe(true);
  });

  it('rejects ids that violate the grammar', () => {
    let thrown: unknown;
    try {
      contributionKey('BAD');
    } catch (error) {
      thrown = error;
    }
    expect(isMoltError(thrown) && thrown.code).toBe('INVALID_DEFINITION');
  });
});

describe('StagedContributions', () => {
  it('stages entries in insertion order and commits them once with generation identity', () => {
    const staged = new StagedContributions('test.plugin', 'test.plugin#7');
    const widget = contributionKey<{ id: string }>('test.ui.widget');
    const command = contributionKey<{ name: string }>('test.ui.command');
    staged.stage(widget, { id: 'w1' });
    staged.stage(command, { name: 'run' });

    const committed = staged.commit();
    expect([...committed.keys()]).toEqual(['test.ui.widget', 'test.ui.command']);
    expect(committed.get('test.ui.widget')).toEqual({
      generationId: 'test.plugin#7',
      pluginId: 'test.plugin',
      value: { id: 'w1' },
    });
    expect(committed.get('test.ui.command')).toEqual({
      generationId: 'test.plugin#7',
      pluginId: 'test.plugin',
      value: { name: 'run' },
    });
  });

  it('commits an empty set without error', () => {
    const staged = new StagedContributions('test.plugin', 'test.plugin#1');
    expect(staged.commit().size).toBe(0);
  });

  it('rejects two different keys sharing one id inside a generation', () => {
    const staged = new StagedContributions('test.plugin', 'test.plugin#1');
    staged.stage(contributionKey('test.ui'), 'first');
    let thrown: unknown;
    try {
      staged.stage(contributionKey('test.ui'), 'second');
    } catch (error) {
      thrown = error;
    }
    expect(isMoltError(thrown) && thrown.code).toBe('INVALID_DEFINITION');
  });

  it('rejects staging after commit (INVALID_STATE)', () => {
    const staged = new StagedContributions('test.plugin', 'test.plugin#1');
    staged.commit();
    let thrown: unknown;
    try {
      staged.stage(contributionKey('test.ui'), 'late');
    } catch (error) {
      thrown = error;
    }
    expect(isMoltError(thrown) && thrown.code).toBe('INVALID_STATE');
  });

  it('rejects double commit (INV-04 at contribution granularity)', () => {
    const staged = new StagedContributions('test.plugin', 'test.plugin#1');
    staged.commit();
    let thrown: unknown;
    try {
      staged.commit();
    } catch (error) {
      thrown = error;
    }
    expect(isMoltError(thrown) && thrown.code).toBe('INVALID_STATE');
  });
});
