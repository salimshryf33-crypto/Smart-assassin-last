/**
 * Unit tests — Visibility Rules
 *
 * Tests the pure logic in visibilityRules.ts:
 *   - computeUploadVisibility: what visibility is assigned at upload time
 *   - canAccessRecord:         what a user can read at request time
 *
 * No DB, no HTTP — pure function tests only.
 * Stop on first failure.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeUploadVisibility,
  canAccessRecord,
} from '../lib/visibilityRules.js';

const ADMIN_UID   = 'admin-uid-001';
const STUDENT_A   = 'student-uid-aaa';
const STUDENT_B   = 'student-uid-bbb';

// ─── computeUploadVisibility ──────────────────────────────────────────────────

describe('computeUploadVisibility', () => {

  // ── Books ───────────────────────────────────────────────────────────────────

  it('book uploaded by admin → public, ownerId null', () => {
    const r = computeUploadVisibility('book', true, ADMIN_UID);
    assert.equal(r.visibility, 'public');
    assert.equal(r.ownerId, null);
  });

  // Note: students cannot upload books (403 gate in route), but the pure rule
  // still returns public for books regardless — the route guard is separate.
  it('book uploaded by student → public, ownerId null (route blocks before this)', () => {
    const r = computeUploadVisibility('book', false, STUDENT_A);
    assert.equal(r.visibility, 'public');
    assert.equal(r.ownerId, null);
  });

  // ── Exams ───────────────────────────────────────────────────────────────────

  it('exam uploaded by admin → public, ownerId null', () => {
    const r = computeUploadVisibility('exam', true, ADMIN_UID);
    assert.equal(r.visibility, 'public');
    assert.equal(r.ownerId, null);
  });

  it('exam uploaded by student → private, ownerId = student uid', () => {
    const r = computeUploadVisibility('exam', false, STUDENT_A);
    assert.equal(r.visibility, 'private');
    assert.equal(r.ownerId, STUDENT_A);
  });

  // ── Notes ───────────────────────────────────────────────────────────────────

  it('note uploaded by admin → private, ownerId = admin uid', () => {
    const r = computeUploadVisibility('note', true, ADMIN_UID);
    assert.equal(r.visibility, 'private');
    assert.equal(r.ownerId, ADMIN_UID);
  });

  it('note uploaded by student → private, ownerId = student uid', () => {
    const r = computeUploadVisibility('note', false, STUDENT_A);
    assert.equal(r.visibility, 'private');
    assert.equal(r.ownerId, STUDENT_A);
  });
});

// ─── canAccessRecord ──────────────────────────────────────────────────────────

describe('canAccessRecord', () => {

  // ── Public records ──────────────────────────────────────────────────────────

  it('public record → any student can access', () => {
    assert.equal(canAccessRecord('public', null, STUDENT_A, false), true);
  });

  it('public record → different student can access', () => {
    assert.equal(canAccessRecord('public', null, STUDENT_B, false), true);
  });

  it('public record → admin can access', () => {
    assert.equal(canAccessRecord('public', null, ADMIN_UID, true), true);
  });

  // ── Private records — owner ─────────────────────────────────────────────────

  it('private record → owner can access their own', () => {
    assert.equal(canAccessRecord('private', STUDENT_A, STUDENT_A, false), true);
  });

  // ── Private records — other student ────────────────────────────────────────

  it('private record → other student cannot access', () => {
    assert.equal(canAccessRecord('private', STUDENT_A, STUDENT_B, false), false);
  });

  it('private record → student with null ownerId cannot access', () => {
    assert.equal(canAccessRecord('private', null, STUDENT_A, false), false);
  });

  // ── Private records — admin override ───────────────────────────────────────

  it('private record → admin can access any private record', () => {
    assert.equal(canAccessRecord('private', STUDENT_A, ADMIN_UID, true), true);
  });

  it('private record → admin can access even with null ownerId', () => {
    assert.equal(canAccessRecord('private', null, ADMIN_UID, true), true);
  });

  // ── Isolation guarantee ─────────────────────────────────────────────────────
  // The critical multi-tenant invariant: student A's private data never leaks
  // to student B, even if both have the same country+subject+grade.

  it('isolation: student A private exam is invisible to student B', () => {
    const { visibility, ownerId } = computeUploadVisibility('exam', false, STUDENT_A);
    const bCanSee = canAccessRecord(visibility, ownerId, STUDENT_B, false);
    assert.equal(bCanSee, false, 'Student B must NOT see Student A private exam');
  });

  it('isolation: student A private notes are invisible to student B', () => {
    const { visibility, ownerId } = computeUploadVisibility('note', false, STUDENT_A);
    const bCanSee = canAccessRecord(visibility, ownerId, STUDENT_B, false);
    assert.equal(bCanSee, false, 'Student B must NOT see Student A private notes');
  });

  it('isolation: admin exam IS visible to student', () => {
    const { visibility, ownerId } = computeUploadVisibility('exam', true, ADMIN_UID);
    const studentCanSee = canAccessRecord(visibility, ownerId, STUDENT_A, false);
    assert.equal(studentCanSee, true, 'Student MUST see admin-uploaded public exam');
  });

  it('isolation: admin book IS visible to student', () => {
    const { visibility, ownerId } = computeUploadVisibility('book', true, ADMIN_UID);
    const studentCanSee = canAccessRecord(visibility, ownerId, STUDENT_A, false);
    assert.equal(studentCanSee, true, 'Student MUST see admin-uploaded public book');
  });
});
