-- A song picked from the licensed catalogue is referenced by URL (we never copy the audio), with the credit shown to viewers.
alter table status_updates add column audio_url text;
alter table status_updates add column audio_art text;
alter table status_updates add column audio_credit text;
