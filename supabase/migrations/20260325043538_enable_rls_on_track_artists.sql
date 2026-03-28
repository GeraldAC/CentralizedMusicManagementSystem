ALTER TABLE track_artists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_track_artists"
ON track_artists
FOR SELECT
TO anon
USING (true);