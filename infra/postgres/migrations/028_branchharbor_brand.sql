BEGIN;

UPDATE organizations
SET slug = 'branchharbor', name = 'BranchHarbor Team'
WHERE id = '00000000-0000-4000-8000-000000000001';

UPDATE users
SET email = 'admin@branchharbor.local', name = 'BranchHarbor Admin'
WHERE id = '00000000-0000-4000-8000-000000000101';

UPDATE users
SET email = 'member@branchharbor.local'
WHERE id = '00000000-0000-4000-8000-000000000102';

UPDATE user_credentials
SET password_hash = 'scrypt$16384$8$1$O8btwPsdg0RH_1M6nsijLg$vKlo8r01U2QOMdUcEJeYEsu9OFLh-cospR7qE4ZnrNp4FCWuIhPYOIRiHNYV5aPQkIpdfgXi6E6Gpl3hER_adw',
    updated_at = NOW()
WHERE user_id = '00000000-0000-4000-8000-000000000101'
  AND password_hash = 'scrypt$16384$8$1$jasIWNbryLjULPNvQ8hRng$UmS5R4Gb4LhIBlisWNk5wJurW7_T7UjyonPYHvHIqxW3J0LQPkN7-PA-Bd0ADgkec27tpOD_nNFbqoZhvfOCRA';

UPDATE user_credentials
SET password_hash = 'scrypt$16384$8$1$GtugNUA6kmRJgMcCOVJkYw$mELzfdZlOL9RKMWV8WyBDepeljGYwHAco-EpGAXw2PpO4NGBItvmFlNN0URJlyk58_OSqcRt9zWpVDJw_mOUJw',
    updated_at = NOW()
WHERE user_id = '00000000-0000-4000-8000-000000000102'
  AND password_hash = 'scrypt$16384$8$1$fIcJIOcO955z3XUwj11yRw$FmbwwyBu_1MtTHukrD8bLo3dqAmtuS6wtWpAafxvrqRioDwoURepH_9ycj81IFcWj_OtiOvtu_gzDvteu2a7ww';

COMMIT;
