// The only module that imports `semver`. Range and version validation happen
// once, at definition-validation time; resolution only calls satisfiesRange.
// Version comparison anywhere else is forbidden: a single choke point keeps
// provider selection consistent.

import { satisfies, valid, validRange } from 'semver';

export function isValidVersion(version: string): boolean {
  return valid(version) !== null;
}

export function isValidRange(range: string): boolean {
  return validRange(range) !== null;
}

export function satisfiesRange(version: string, range: string): boolean {
  return satisfies(version, range);
}
