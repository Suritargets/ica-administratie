export const ROLES = ['admin', 'boekhouder', 'medewerker', 'alleen-lezen'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  boekhouder: 'Boekhouder',
  medewerker: 'Medewerker',
  'alleen-lezen': 'Alleen-lezen',
};

// Wat mag welke rol? (de server dwingt dit af; de UI verbergt alleen knoppen)
export type Perm =
  | 'docs.write' | 'docs.delete'
  | 'clients.write' | 'clients.delete'
  | 'catalog.write' | 'catalog.delete'
  | 'rates.write'
  | 'settings.write'
  | 'users.manage' | 'data.export';

const MATRIX: Record<Role, Perm[]> = {
  admin: ['docs.write', 'docs.delete', 'clients.write', 'clients.delete', 'catalog.write', 'catalog.delete', 'rates.write', 'settings.write', 'users.manage', 'data.export'],
  boekhouder: ['docs.write', 'docs.delete', 'clients.write', 'clients.delete', 'catalog.write', 'catalog.delete', 'rates.write'],
  medewerker: ['docs.write', 'clients.write'],
  'alleen-lezen': [],
};

export const can = (role: string, perm: Perm) => (MATRIX[role as Role] ?? []).includes(perm);
export const permsOf = (role: string) => MATRIX[role as Role] ?? [];
export const isRole = (r: unknown): r is Role => ROLES.includes(r as Role);
