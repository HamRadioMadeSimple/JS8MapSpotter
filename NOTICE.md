# Credits and third-party material

JS8Map Spotter is Copyright (C) 2026 MJ Jordan (KW3KW) and is licensed under the
GNU General Public License version 3 (see [LICENSE](LICENSE)). It includes, or
downloads at run time, the material below, which keeps its own license.

## Included in this repository

**Leaflet 1.9.4** (`leaflet.js`, `leaflet.css`): the map display library.
© 2010-2023 Vladimir Agafonkin, © 2010-2011 CloudMade. BSD 2-Clause License.
<https://leafletjs.com>

**MCForms form files** (`forms/MCF*.txt`): the default JS8Spotter MCForms
"micro forms", by KF7MIX (<https://kf7mix.com>). The @SITREP forms are
maintained by SitRepNet / KN4AM (<https://sitrepnet.com>). Each file carries its
own author and date line. They are included so Spotter can decode forms heard
on the air; newer copies can be dropped into the forms folder.

## Downloaded at run time (not in this repository)

**FCC amateur license data** (ULS `l_amat`): a United States government work,
public domain. Downloaded by the first-run setup from fcc.gov.

**Canadian amateur callsign data**: open data published by Innovation, Science
and Economic Development Canada (ISED). Optional; downloaded by the first-run
setup.

**GeoNames US postal codes** (`US.zip`): used to place FCC addresses.
© GeoNames, Creative Commons Attribution 4.0. <https://www.geonames.org>

**Street-level map tiles** (optional, off by default; needs your own key):
© OpenStreetMap contributors, Open Database License; basemap styling © CARTO.

## Related software

**JS8Call** by KN4CRD and contributors, GPL-3.0. JS8Map Spotter talks to it over
its TCP API and does not include any of its code. It is not affiliated with or
endorsed by the JS8Call project.

**JS8Spotter** by KF7MIX. Spotter can optionally read JS8Spotter's database,
read-only, to import traffic heard while Spotter was closed.

**CommStat**: Spotter decodes CommStat StatRep, alert and RRSR messages as heard
on the air.
