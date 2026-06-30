/**
 * Visibility Rules — pure, stateless functions for exam/curriculum access control.
 *
 * Extracted from route logic so they can be unit-tested without a DB connection.
 *
 * Rule summary:
 *   Upload time:
 *     book       (admin only)  → public,  ownerId = null
 *     exam       + admin       → public,  ownerId = null
 *     exam       + student     → private, ownerId = uid
 *     note       + anyone      → private, ownerId = uid
 *
 *   Read time:
 *     public                          → accessible by anyone
 *     private + viewer is owner       → accessible
 *     private + viewer is admin       → accessible
 *     private + viewer is neither     → denied (403)
 */

export type DocType   = 'book' | 'exam' | 'note';
export type Visibility = 'public' | 'private';

export interface UploadVisibility {
  visibility: Visibility;
  ownerId:    string | null;
}

/**
 * Determine visibility and ownerId at upload time.
 *
 * @param docType   - type of document being uploaded
 * @param isAdmin   - whether the uploading user is an admin
 * @param uid       - UID of the uploading user (used as ownerId for private docs)
 */
export function computeUploadVisibility(
  docType:  DocType,
  isAdmin:  boolean,
  uid:      string
): UploadVisibility {
  const isPublic =
    docType === 'book' ||
    (docType === 'exam' && isAdmin);

  return {
    visibility: isPublic ? 'public' : 'private',
    ownerId:    isPublic ? null : uid,
  };
}

/**
 * Determine whether a given user may read a document/record.
 *
 * @param visibility  - stored visibility of the record
 * @param ownerId     - stored ownerId of the record (null for public)
 * @param viewerUid   - UID of the requesting user
 * @param viewerAdmin - whether the requesting user is an admin
 */
export function canAccessRecord(
  visibility:  Visibility,
  ownerId:     string | null,
  viewerUid:   string,
  viewerAdmin: boolean
): boolean {
  if (visibility === 'public') return true;
  if (viewerAdmin)             return true;
  if (ownerId === viewerUid)   return true;
  return false;
}
