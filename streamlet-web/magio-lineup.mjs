// Official Magio TV cez internet lineup, Telekom PDF valid from 31. 7. 2026.
// XL = Basic + all 6 thematic packs + Extra L + Extra XL. Premium packs are excluded.
export const MAGIO_XL_GROUPS = [
  ['zakladny', '01 Základný balíček', [
    'Jednotka HD','Dvojka HD',':24 HD','ŠPORT HD','Markíza HD','Markíza Klasik HD','Markíza KRIMI HD','Doma HD','Dajto HD','JOJ HD','Plus HD','JOJ KRIMI HD','JOJ 24 HD','JOJ Svet HD','TA3 HD','ČT1 HD','ČT2 HD','ČT24 HD','Folklorika TV HD','Lux TV HD','Noe','Spektrum Home','Nova Intl. HD','Prima SK HD','Prima KRIMI SK HD','Prima COOL SK HD','Prima LOVE SK HD','CNN Prima News HD','CNN Intl. Europe','TV REBEL','Šlágr Premium HD','Senzi','Kino Barrandov HD','FREEDOM','Relax','Leo TV Gold 18+ HD','France 24','France 24 FR','BBC World News','Euronews','Canal 24 Horas','Rai 1','TVP Polonia','TV OSEM HD','DETSKÉ KINO HD','MAGIO LIFESTYLE HD','TV Bratislava','TV Bánovce','TV Nitrička','TV Komárno','TV Romana','TV Ružomberok','TV Hronka','TV 7','KTV Kežmarská televízia','TV VEGA','TV Reduta','TV Slovensko','TV9','TV Krea','Považie','TV Raj','TV Turiec','TV Poprad','MsTV Kežmarok','RVTV','DTV','DSTV','TV SEN','TV Myjava','TV Stará Turá','TV Brezová','VIO BS','TV Dolný Kubín'
  ]],
  ['hudba-deti', '02 Hudba a deti', [
    'JOJko HD','TV Rik HD','Turbo TV HD','Cartoon Network HD','Minimax','Jim Jam','Disney Channel','LaLa TV HD','Retro Music TV','Óčko HD','MAGIO MUSIC HD','Music Box Classic HD'
  ]],
  ['volny-cas', '03 Voľný čas', [
    'Film Europe +','Viasat Epic Drama HD','Šláger Originál HD','Šláger Muzika HD','Viasat True Crime HD'
  ]],
  ['sportovy', '04 Športový', [
    'Eurosport 1 HD','Eurosport 2 HD','Sport 1 HD','Sport 2 HD','Nova Sport 1 HD','Nova Sport 2 HD','JOJ Šport HD','JOJ Šport 2 HD'
  ]],
  ['filmovy', '05 Filmový', [
    'CS Film – CS Horror HD','FILMBOX+ One HD','Film Europe HD','JOJ Cinema HD','AMC HD','Film+ HD'
  ]],
  ['dokumentarny', '06 Dokumentárny', [
    'NGC HD','NGC Wild HD','Spektrum HD','Travel Channel HD','Viasat History HD','Viasat Nature HD','Viasat Explore HD','Love Nature 4K','Fishing and Hunting','Kanal 1 HD'
  ]],
  ['styl-fakty', '07 Štýl a fakty', [
    'Discovery Channel HD','Animal Planet HD','History Channel HD','TLC HD','Discovery ID HD','Eroxxx 18+ HD','DVTV EXTRA HD','TV Paprika HD'
  ]],
  ['extra-l', '08 Extra balíček L', [
    'CANAL+ Action HD','CANAL+ Sport 2 HD','CANAL+ Sport 3 HD','Nova Sport 3 HD','Nova Sport 4 HD','Premier Sport 1 HD','Premier Sport 2 HD','Premier Sport 3 HD','Arena Sport 1 HD','Arena Sport 2 HD','BBC Earth HD','STRIKE TV HD','BBC First HD','Babes TV HD','Fashion Box HD','Fast and Fun Box HD','360Tune Box HD','Disney Junior','Baby TV HD','Music Box Sexy HD','DRAMOX HD'
  ]],
  ['extra-xl', '09 Extra balíček XL', [
    'Nova Sport 5 HD','Nova Sport 6 HD','CANAL+ Sport HD','CANAL+ Sport 4 HD','CANAL+ Sport 5 HD','CANAL+ Sport 6 HD','CANAL+ Sport 7 HD','CANAL+ Sport 8 HD','Duck TV HD','Ginx eSports TV HD','Golf Channel HD','CS History','Crime and Inv.','Food Network HD','Auto Motor Sport HD','Travel XP HD','Travel XP 4K(Beta) HD','CS Mystery','FILMBOX+ Emotion HD','FILMBOX+ Love&Crime HD','FILMBOX+ Hits HD','FILMBOX+ Commedy','Stingray Classica HD','Stingray Djazz HD','iConcerts HD','Óčko Expres HD','Óčko Black HD','Óčko Star HD','Fightbox HD','Extreme sports','LEO TV 18+','Dorcel TV 18+ HD','Dusk TV 18+','Men TV 18+','Erox 18+ HD','Brazzers TV EU 18+','True Amateurs 18+ HD','English Club HD','Tiny Teen HD','Music Box Dance HD','Music Box Hits HD','DocuBox HD','MyZen HD','FUEL HD','FILMBOX+ Festival HD'
  ]]
];

export const MAGIO_ALIASES = {
  ':24 HD': ['24', '24sk'],
  'ŠPORT HD': ['sport', 'rtvssport', 'sportsk'],
  'Nova Intl. HD': ['novainternational', 'novaintl'],
  'CNN Prima News HD': ['cnnprimanews', 'primacnnnews'],
  'CNN Intl. Europe': ['cnninternational', 'cnninteleurope', 'cnn'],
  'Canal 24 Horas': ['canal24horas', '24horas'],
  'TV Rik HD': ['tvrik', 'rik'],
  'Film Europe +': ['filmeuropeplus'],
  'CS Film – CS Horror HD': ['csfilm', 'cshorror'],
  'FILMBOX+ One HD': ['filmboxone', 'filmboxplusone'],
  'NGC HD': ['nationalgeographic', 'ngc'],
  'NGC Wild HD': ['nationalgeographicwild', 'natgeowild', 'ngcwild'],
  'Discovery ID HD': ['investigationdiscovery', 'discoveryid', 'id'],
  'Crime and Inv.': ['crimeandinvestigation', 'crimeandinvestigationnetwork'],
  'CANAL+ Action HD': ['canalplusaction', 'canalplusactioneurope'],
  'CANAL+ Sport HD': ['canalplussport', 'canalplussportsk'],
  'CANAL+ Sport 2 HD': ['canalplussport2', 'canalplussport2sk'],
  'CANAL+ Sport 3 HD': ['canalplussport3', 'canalplussport3sk'],
  'CANAL+ Sport 4 HD': ['canalplussport4', 'canalplussport4sk'],
  'CANAL+ Sport 5 HD': ['canalplussport5', 'canalplussport5sk'],
  'CANAL+ Sport 6 HD': ['canalplussport6', 'canalplussport6sk'],
  'CANAL+ Sport 7 HD': ['canalplussport7', 'canalplussport7sk'],
  'CANAL+ Sport 8 HD': ['canalplussport8', 'canalplussport8sk'],
  'Duck TV HD': ['ducktv', 'ducktvplus'],
  'Ginx eSports TV HD': ['ginxesportstv', 'ginx'],
  'FILMBOX+ Emotion HD': ['filmboxemotion', 'filmboxplusemotion'],
  'FILMBOX+ Love&Crime HD': ['filmboxlovecrime', 'filmboxpluslovecrime'],
  'FILMBOX+ Hits HD': ['filmboxhits', 'filmboxplushits'],
  'FILMBOX+ Commedy': ['filmboxcomedy', 'filmboxpluscomedy'],
  'FILMBOX+ Festival HD': ['filmboxfestival', 'filmboxplusfestival'],
  'Fightbox HD': ['fightbox'],
  'Extreme sports': ['extremesports'],
  'BBC World News': ['bbcnews', 'bbcworldnews'],
  'France 24 FR': ['france24french', 'france24fr'],
  'France 24': ['france24english', 'france24'],
  'TVP Polonia': ['tvppolonia'],
  'Kino Barrandov HD': ['kinobarrandov'],
  'Lux TV HD': ['tvlux', 'lux'],
  'Noe': ['tvnoe', 'noe'],
  'TV OSEM HD': ['tvosem'],
  'TV 7': ['tv7'],
  'KTV Kežmarská televízia': ['ktvkezmarska', 'kezmarskatelevizia'],
  'MsTV Kežmarok': ['mstvkezmarok'],
  'Považie': ['tvpovazie', 'povazie'],
  'Šlágr Premium HD': ['slagerpremium'],
  'Šláger Originál HD': ['slageroriginal'],
  'Šláger Muzika HD': ['slagermuzika'],
  'Retro Music TV': ['retromusictv'],
  'Óčko HD': ['ocko'],
  'Óčko Expres HD': ['ockoexpres'],
  'Óčko Black HD': ['ockoblack'],
  'Óčko Star HD': ['ockostar'],
  'Viasat Epic Drama HD': ['viasatepicdrama', 'epicdrama'],
  'Viasat True Crime HD': ['viasattruecrime'],
  'TV Paprika HD': ['tvpaprika', 'paprika'],
  'Auto Motor Sport HD': ['automotorsport'],
  'Travel XP 4K(Beta) HD': ['travelxp4k', 'travelxp4kbeta'],
  'Music Box Classic HD': ['musicboxclassic'],
  'Music Box Dance HD': ['musicboxdance'],
  'Music Box Hits HD': ['musicboxhits'],
  'Music Box Sexy HD': ['musicboxsexy']
};
