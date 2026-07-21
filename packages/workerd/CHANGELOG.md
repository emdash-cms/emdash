# @emdash-cms/sandbox-workerd

## 0.3.0

### Minor Changes

- [#2122](https://github.com/emdash-cms/emdash/pull/2122) [`6bbf93a`](https://github.com/emdash-cms/emdash/commit/6bbf93a43969a41648505668becfde60aa10e8dd) Thanks [@bimsonz](https://github.com/bimsonz)! - Expose the host Astro project's `trailingSlash` config to plugins via `ctx.site.trailingSlash`, so plugins that build absolute URLs (sitemaps, canonical, hreflang) can match the site's routing policy. Available to in-process and sandboxed plugins alike.

### Patch Changes

- Updated dependencies [[`82827d3`](https://github.com/emdash-cms/emdash/commit/82827d3f8ffdaa4fae688b89cdcc139aa6c25810), [`fbb04ab`](https://github.com/emdash-cms/emdash/commit/fbb04abcff5b909e28541d3b3e5fca3089870b83), [`07c2b0f`](https://github.com/emdash-cms/emdash/commit/07c2b0f999e35e00153e349f74eb9298669b5fbf), [`460efe6`](https://github.com/emdash-cms/emdash/commit/460efe645baae54ee01b5d42643fc9ac5a926ee1), [`7b9e558`](https://github.com/emdash-cms/emdash/commit/7b9e5589a79435b8cf069528fdbdb4dd9b8988ae), [`aa7ef09`](https://github.com/emdash-cms/emdash/commit/aa7ef096c9ab6628920469fb6a4a75bc9b13395f), [`c180240`](https://github.com/emdash-cms/emdash/commit/c18024003340ad5a03076313057284a0f4eea2be), [`039c5dc`](https://github.com/emdash-cms/emdash/commit/039c5dc6d5ecef03bc8be68616234834abdd20cc), [`b66d8a0`](https://github.com/emdash-cms/emdash/commit/b66d8a086ea9fd02acb34d4fb90c54ea155c7120), [`fc6cdfb`](https://github.com/emdash-cms/emdash/commit/fc6cdfbf2e68c23e916518993b229e38868d1510), [`8d6b20b`](https://github.com/emdash-cms/emdash/commit/8d6b20b18fe0570c491de45f60eddb86c1bc1fe7), [`6bbf93a`](https://github.com/emdash-cms/emdash/commit/6bbf93a43969a41648505668becfde60aa10e8dd), [`1b1ff42`](https://github.com/emdash-cms/emdash/commit/1b1ff42c924056806875ab34f39bbb0bc9e60e74), [`e2c7549`](https://github.com/emdash-cms/emdash/commit/e2c7549d7b98c6cc97ba47ca6de5dd1b532e9c8f), [`6c96ac8`](https://github.com/emdash-cms/emdash/commit/6c96ac8b68d6ba514aba51d5a5282c499afc22d6), [`7ff08db`](https://github.com/emdash-cms/emdash/commit/7ff08dbea6407b566dd5ea7c159510fd871e01b9), [`23a740a`](https://github.com/emdash-cms/emdash/commit/23a740ad3deb248d00f29559e0cc9c7bfa49ec1f), [`6fb52b0`](https://github.com/emdash-cms/emdash/commit/6fb52b08139dead03f61324abe1ed10a9e5552e0), [`a27a5cc`](https://github.com/emdash-cms/emdash/commit/a27a5ccda339cc61df452e025e736addbafd1f9a), [`4c57ee2`](https://github.com/emdash-cms/emdash/commit/4c57ee216f242ef163ae269ec6ff6abfba716e6f), [`e52dea9`](https://github.com/emdash-cms/emdash/commit/e52dea9b72b043d62348f8d01eefade2ce66484c), [`3f8b778`](https://github.com/emdash-cms/emdash/commit/3f8b77822bf8e89b065884c53c7e8b7676788c48), [`de44730`](https://github.com/emdash-cms/emdash/commit/de44730990e8a10b70b0a64ed3747f7038a31eec), [`32be60b`](https://github.com/emdash-cms/emdash/commit/32be60b87f091e24897c78d39b5d15de93946aab), [`d4c565e`](https://github.com/emdash-cms/emdash/commit/d4c565ef99dde5f0a5fafa55b3ca4353dd6d3168), [`b22a3d5`](https://github.com/emdash-cms/emdash/commit/b22a3d5cca0b7217bab3f5fa8c90821fa0eb981c), [`32f8261`](https://github.com/emdash-cms/emdash/commit/32f8261fc028dc6941a14d891a83722c8c830209), [`4b7fd08`](https://github.com/emdash-cms/emdash/commit/4b7fd08468caf7897f9c23a238da27cda8cdf171), [`cf6e4fa`](https://github.com/emdash-cms/emdash/commit/cf6e4fa5d259c24d7ae3038c55039fc56c6c2923), [`d303738`](https://github.com/emdash-cms/emdash/commit/d30373826208bd0182e842d20ca718a78a0585c6), [`6a79b03`](https://github.com/emdash-cms/emdash/commit/6a79b03e6f11c61098f78b81d878604e2ac903e0), [`34b3017`](https://github.com/emdash-cms/emdash/commit/34b30171b1bca29110b64d6ab317e5145150807b), [`6890edd`](https://github.com/emdash-cms/emdash/commit/6890edd3b82b076da43d43685195321e83f50914), [`65be947`](https://github.com/emdash-cms/emdash/commit/65be947258ad22dbd75339e65d1745bb7ebb7c95), [`cfdb8f0`](https://github.com/emdash-cms/emdash/commit/cfdb8f00ea18dc728e6e0fb910cc71d56478ea63), [`ca660c6`](https://github.com/emdash-cms/emdash/commit/ca660c6c9043efe115b851d696a12757d9539f25), [`c4a2ffd`](https://github.com/emdash-cms/emdash/commit/c4a2ffd683a94b2ed015862cd81be9d6e74cdb3d), [`c24b7d3`](https://github.com/emdash-cms/emdash/commit/c24b7d3be5efa95e7874e48360e31fdc8b27a06d), [`84173dd`](https://github.com/emdash-cms/emdash/commit/84173dd64ed67da3035f88f37fc573c9fe9753a5), [`c350e86`](https://github.com/emdash-cms/emdash/commit/c350e86d77b9b6b64963bb3d246daa23979feb4a), [`e649af8`](https://github.com/emdash-cms/emdash/commit/e649af8a7912bf2331341a5d2a4c5a960d27e422)]:
  - emdash@0.30.0

## 0.2.0

### Minor Changes

- [#1719](https://github.com/emdash-cms/emdash/pull/1719) [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260) Thanks [@swissky](https://github.com/swissky)! - Adds a `taxonomies:read` plugin capability with read-only taxonomy access: plugins that declare it get `ctx.taxonomies` to list taxonomy definitions (`getAll()`), fetch the terms of a taxonomy (`getTerms()`), and read the terms assigned to a content entry (`getEntryTerms()`) — in-process and in both sandbox runners.

### Patch Changes

- Updated dependencies [[`582ea2c`](https://github.com/emdash-cms/emdash/commit/582ea2c6d970ff8f7224c46fbe9cf2b7cc2470ef), [`77e8968`](https://github.com/emdash-cms/emdash/commit/77e8968d906cb4c6cb76c095c7b758a120d6a017), [`e12f393`](https://github.com/emdash-cms/emdash/commit/e12f393fcb70255a5fe74c2ee7ad4f7c23e0bbfd), [`e4e76f5`](https://github.com/emdash-cms/emdash/commit/e4e76f5a5511c5ad42e40b112201d0f426186149), [`0360900`](https://github.com/emdash-cms/emdash/commit/0360900dfa6be62d44d6ce259db1713dae8a4c2e), [`cbc7d6b`](https://github.com/emdash-cms/emdash/commit/cbc7d6b806e993e7a51c47ffa4abb9b31b3d61f5), [`15f4057`](https://github.com/emdash-cms/emdash/commit/15f4057abf0c55a36396d4b8f05e818277b01898), [`1526f96`](https://github.com/emdash-cms/emdash/commit/1526f96c0728ccaf07ecd295170d0ba18e121e8d), [`b116525`](https://github.com/emdash-cms/emdash/commit/b116525425d3687cfe1356704e71ce27832d1db7), [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260), [`450ea81`](https://github.com/emdash-cms/emdash/commit/450ea810aff6b6dfa3797bb99155386189a8a853), [`58f594b`](https://github.com/emdash-cms/emdash/commit/58f594b59641649a445231b56a2dfbdcab434611), [`c57b12b`](https://github.com/emdash-cms/emdash/commit/c57b12ba07ef381e90d132b32aab3ac7b3b3351a), [`9c0733f`](https://github.com/emdash-cms/emdash/commit/9c0733f6f54aa250039a5d0da29b8d8aa9d144cf), [`60811c0`](https://github.com/emdash-cms/emdash/commit/60811c0313096dd485ee9075a0186eb51fc57ca6)]:
  - emdash@0.29.0

## 0.1.19

### Patch Changes

- Updated dependencies [[`b92807f`](https://github.com/emdash-cms/emdash/commit/b92807f02b3c7da9a19a0758a2213c6bda7ddc4c), [`9e4701e`](https://github.com/emdash-cms/emdash/commit/9e4701e89cffd77e98ea10f46731c47e2815b4e6)]:
  - emdash@0.28.1

## 0.1.18

### Patch Changes

- Updated dependencies [[`1866fa3`](https://github.com/emdash-cms/emdash/commit/1866fa346e1d4178c60db0fa437b65c0965b1475), [`b36d15c`](https://github.com/emdash-cms/emdash/commit/b36d15c1523dc6e0ada57b4c838f8948b3fbd4fa), [`a3ec23d`](https://github.com/emdash-cms/emdash/commit/a3ec23ddc36889e16a967049de233f21432165a6), [`cdca719`](https://github.com/emdash-cms/emdash/commit/cdca7194b2509993fbb1fc3c39e2e70c8d796ad7), [`ee5bfe6`](https://github.com/emdash-cms/emdash/commit/ee5bfe6b479b736e0432a4d614f5efa01fce02e7), [`a9e9dde`](https://github.com/emdash-cms/emdash/commit/a9e9dde98a9433a1c186490a24865587f1774fd9), [`a9e9dde`](https://github.com/emdash-cms/emdash/commit/a9e9dde98a9433a1c186490a24865587f1774fd9), [`7d16d95`](https://github.com/emdash-cms/emdash/commit/7d16d955003079c8c4a3093decf56bd4f4f05f8a), [`dd05063`](https://github.com/emdash-cms/emdash/commit/dd050637323731fe7795dbc9cf0c3edd906d6908), [`e2dd273`](https://github.com/emdash-cms/emdash/commit/e2dd2738404b7df57ca5e1d50d31b222218d3734), [`92fd412`](https://github.com/emdash-cms/emdash/commit/92fd41227225c425c703e0a0bb62b963c1cd4391), [`932f4ba`](https://github.com/emdash-cms/emdash/commit/932f4ba3adef8be21abc39b4cc7612609895e88c), [`15b4d2d`](https://github.com/emdash-cms/emdash/commit/15b4d2d189142abb69f5c9223c4c1f10363e837f)]:
  - emdash@0.28.0

## 0.1.17

### Patch Changes

- Updated dependencies [[`7422460`](https://github.com/emdash-cms/emdash/commit/7422460adf85863abfc27e8f83ba0cb40a3e942a), [`e4eab4f`](https://github.com/emdash-cms/emdash/commit/e4eab4fba69f1cf249db192938d397aa1b116015), [`46ef945`](https://github.com/emdash-cms/emdash/commit/46ef945d5fcffeef4ac9aecd2fb63fcb49c24b65), [`cff8498`](https://github.com/emdash-cms/emdash/commit/cff84987c679faa61bf491c630b3f77d0083ca21), [`dea8210`](https://github.com/emdash-cms/emdash/commit/dea82106602bb6dde0edd8c007a5acfa5fd7600d), [`90ffe40`](https://github.com/emdash-cms/emdash/commit/90ffe40a1a31193b2f29ef92202e4f339a2487fa), [`386faf5`](https://github.com/emdash-cms/emdash/commit/386faf5bd724ce0b47240e9176c92f554fd66c00), [`2a7063a`](https://github.com/emdash-cms/emdash/commit/2a7063a4e44a7ebb770f1cb28acb5bffac15fca2)]:
  - emdash@0.27.0

## 0.1.16

### Patch Changes

- Updated dependencies [[`facdcfc`](https://github.com/emdash-cms/emdash/commit/facdcfc745059a6f183581963fcc29c8b6efec63), [`f44a277`](https://github.com/emdash-cms/emdash/commit/f44a2775c8e87be1398befcb29da6bec28bad01c), [`971c627`](https://github.com/emdash-cms/emdash/commit/971c6271e810a8e12e63303778a132a48eb75f4a), [`e5b95e1`](https://github.com/emdash-cms/emdash/commit/e5b95e195e1307237db9eb26806c54c76cc0f81d), [`13b87b7`](https://github.com/emdash-cms/emdash/commit/13b87b70296443db14bf163cd3b25ff2a5701227), [`8f7604d`](https://github.com/emdash-cms/emdash/commit/8f7604dfd8f274b7a62bcbccd53068930b304777), [`5dea403`](https://github.com/emdash-cms/emdash/commit/5dea4035ec2f15fa2248e1621386a91320d50f6d), [`3d80be5`](https://github.com/emdash-cms/emdash/commit/3d80be5e0f1e91844bcf138dea8e86861bc484b4), [`d1116ae`](https://github.com/emdash-cms/emdash/commit/d1116ae6d02f5c15ea5efb68cce78bb24f13ccb6), [`192741f`](https://github.com/emdash-cms/emdash/commit/192741f9a34ede62e23c3de63e3b2483f0b948b6), [`737da19`](https://github.com/emdash-cms/emdash/commit/737da19f56998a5e7f77eecf9337d5f29a18cea6), [`5299d38`](https://github.com/emdash-cms/emdash/commit/5299d38d9c7e92b9faafbe24820164517fc2360c)]:
  - emdash@0.26.0

## 0.1.15

### Patch Changes

- Updated dependencies [[`d4237eb`](https://github.com/emdash-cms/emdash/commit/d4237ebb875321b2b160034f03321a57f366c495), [`2216dca`](https://github.com/emdash-cms/emdash/commit/2216dcab39d7c0034af81be3543c8440a10d8961)]:
  - emdash@0.25.1

## 0.1.14

### Patch Changes

- Updated dependencies [[`942fac6`](https://github.com/emdash-cms/emdash/commit/942fac6c87d7a6ce3a62ec7e0610887db5a44f3f), [`1f4aa59`](https://github.com/emdash-cms/emdash/commit/1f4aa59a284bb6fa10dd9672a671b62a2a1ba3aa), [`38a63d5`](https://github.com/emdash-cms/emdash/commit/38a63d54e7c7c2735caa179b303c63c175a9570e), [`0f8d1ff`](https://github.com/emdash-cms/emdash/commit/0f8d1ffc081e31217eadc0d71051d7c7324ca173)]:
  - emdash@0.25.0

## 0.1.13

### Patch Changes

- Updated dependencies [[`489a4d1`](https://github.com/emdash-cms/emdash/commit/489a4d130fea2fdc231aae93d6d2966601b51ceb), [`489a4d1`](https://github.com/emdash-cms/emdash/commit/489a4d130fea2fdc231aae93d6d2966601b51ceb)]:
  - emdash@0.24.1

## 0.1.12

### Patch Changes

- Updated dependencies [[`79fc8b5`](https://github.com/emdash-cms/emdash/commit/79fc8b5b16b07001f5c0a4d964c2ac1fabd39573), [`e659a5c`](https://github.com/emdash-cms/emdash/commit/e659a5c25001ec181c8771e17a8c3264d1498fbf), [`d8487f9`](https://github.com/emdash-cms/emdash/commit/d8487f99ba05b9b96e3a200d8b1f0e1902c4ac8c)]:
  - emdash@0.24.0

## 0.1.11

### Patch Changes

- Updated dependencies [[`b4d7228`](https://github.com/emdash-cms/emdash/commit/b4d7228d5e28d665a32083ac82ce9346baac639a), [`d74269d`](https://github.com/emdash-cms/emdash/commit/d74269d5a538584a1db4ba82e8ab20113cd955e7), [`e39984f`](https://github.com/emdash-cms/emdash/commit/e39984f9ea688faea01b83a611ffe36b6f984a26), [`280b877`](https://github.com/emdash-cms/emdash/commit/280b8771274b2e8f9d0d54b698592ae162374805), [`7fca12f`](https://github.com/emdash-cms/emdash/commit/7fca12f0a8fbe3c1c0f6ea0d2a9826eb51a1da57), [`fd077e0`](https://github.com/emdash-cms/emdash/commit/fd077e0892dedd1eb03c422e07aa54e180ddc0ff), [`9ebb47e`](https://github.com/emdash-cms/emdash/commit/9ebb47e199a86ba13b9555b8b3e4f7c28f241d63), [`8c7bc81`](https://github.com/emdash-cms/emdash/commit/8c7bc81690bd1e3b39ef0bfeb234ea7d3ac49f39), [`55613e1`](https://github.com/emdash-cms/emdash/commit/55613e1242a7b11c1dd632c9e50b8bd5f57b2baf), [`c5f58b9`](https://github.com/emdash-cms/emdash/commit/c5f58b9a8aeb369baf0b1b0bc2738373c03d2e01), [`bd6cc3a`](https://github.com/emdash-cms/emdash/commit/bd6cc3ad2fe29ee8016843168fb8aa1dc38d33de), [`c056060`](https://github.com/emdash-cms/emdash/commit/c056060cdbf29b823591c5796e38d03a66fcba70), [`c43c412`](https://github.com/emdash-cms/emdash/commit/c43c412500e5bc067371f6e680ff3b7b8a726873), [`b5ea8e7`](https://github.com/emdash-cms/emdash/commit/b5ea8e70db242472784bd4957e65d5fdb9fecd89), [`c5f58b9`](https://github.com/emdash-cms/emdash/commit/c5f58b9a8aeb369baf0b1b0bc2738373c03d2e01)]:
  - emdash@0.23.0

## 0.1.10

### Patch Changes

- Updated dependencies [[`0bfab91`](https://github.com/emdash-cms/emdash/commit/0bfab91765514f4a8bd164d7373c8c81e3d5b446), [`cf17c9f`](https://github.com/emdash-cms/emdash/commit/cf17c9f4c8faa46857d92d4b168452d2469dba4b), [`707edee`](https://github.com/emdash-cms/emdash/commit/707edee3bdf31b53f33507e1f528a0e5803fd150), [`a36b5f3`](https://github.com/emdash-cms/emdash/commit/a36b5f3e1e452d48a690878d4f078f85a6d99715), [`d46abfd`](https://github.com/emdash-cms/emdash/commit/d46abfdb739f8d242eddba5ebfda09a8648c8ecf), [`ed921d8`](https://github.com/emdash-cms/emdash/commit/ed921d80ec33fa114d9c8a7f9221f1fbeb24d658), [`6a97bac`](https://github.com/emdash-cms/emdash/commit/6a97bacaf6ef8b006b32879e4625ebb48da6f5bd), [`c219aff`](https://github.com/emdash-cms/emdash/commit/c219aff3b867e178ee267823801db66bbc9b1621), [`640e60a`](https://github.com/emdash-cms/emdash/commit/640e60a56e3d3e60925ba4d7a1cf0fbd04b3d5c2), [`ca47da4`](https://github.com/emdash-cms/emdash/commit/ca47da485ddcf46f7fa7b8efa15c3c20a11c2300), [`cb1c689`](https://github.com/emdash-cms/emdash/commit/cb1c68948072c479ed924b52867809bc8ad1c9e5), [`a623c6b`](https://github.com/emdash-cms/emdash/commit/a623c6b7dbdc82c8562f32a619af23ea147306b6)]:
  - emdash@0.22.0

## 0.1.9

### Patch Changes

- Updated dependencies [[`b6a5fac`](https://github.com/emdash-cms/emdash/commit/b6a5fac6d3bc88cc5ab49889de264c37262cc5f7), [`23c37f3`](https://github.com/emdash-cms/emdash/commit/23c37f35dfe9ce23fca0d48acea228299d25e19e), [`997d7ee`](https://github.com/emdash-cms/emdash/commit/997d7eea8f39c16eef28577bb8ace0c0413fc38b), [`e9cd7b7`](https://github.com/emdash-cms/emdash/commit/e9cd7b7821c5a081257cb56bb857b7950e2b1527), [`37e848b`](https://github.com/emdash-cms/emdash/commit/37e848bf005950a4b312cf5f0a50f7c8820b01fc)]:
  - emdash@0.21.0

## 0.1.8

### Patch Changes

- Updated dependencies [[`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b), [`7688f0b`](https://github.com/emdash-cms/emdash/commit/7688f0b6a92ccfdcea6244100c07679e81014161), [`c7166b0`](https://github.com/emdash-cms/emdash/commit/c7166b083eaa2ceb37f8d9682f4a521e5e360a19), [`9c994ad`](https://github.com/emdash-cms/emdash/commit/9c994ada4692d34517ab458f29b8613aa9341ecc), [`eddaf91`](https://github.com/emdash-cms/emdash/commit/eddaf91a6a818cad12bc8f5e14ee16f8189cc073), [`afc3a0f`](https://github.com/emdash-cms/emdash/commit/afc3a0f6f3f0fa831b6c2e7e8ddebb4a7c631007), [`3d423a7`](https://github.com/emdash-cms/emdash/commit/3d423a796d7d000160dc7d8d0a582ba7734f214f), [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4), [`3e344af`](https://github.com/emdash-cms/emdash/commit/3e344af2c162e37dfa389b9cb88c2c826590b678), [`7688f0b`](https://github.com/emdash-cms/emdash/commit/7688f0b6a92ccfdcea6244100c07679e81014161), [`8807701`](https://github.com/emdash-cms/emdash/commit/880770148329fa14ccb1c35d438ae6e53c8e2c97)]:
  - emdash@0.20.0

## 0.1.7

### Patch Changes

- Updated dependencies [[`e96587f`](https://github.com/emdash-cms/emdash/commit/e96587f8ff393939355d3d643a322fe7b2c07c86), [`023893a`](https://github.com/emdash-cms/emdash/commit/023893a0fa966b95aad4ff533fc2966b3e3dfe03), [`f41092b`](https://github.com/emdash-cms/emdash/commit/f41092bd847f1eb161034f1d2c67976e8473e794), [`cedfcc5`](https://github.com/emdash-cms/emdash/commit/cedfcc527d47131baaa5dcfb29fb7b4a966265d5), [`c63f9ca`](https://github.com/emdash-cms/emdash/commit/c63f9ca56a8fc0cf4e1843887291fee0d78d89a2), [`61ea3c9`](https://github.com/emdash-cms/emdash/commit/61ea3c9fee5b0f11974895a278d8297c56abec0b), [`a4c2af2`](https://github.com/emdash-cms/emdash/commit/a4c2af20ee27fef891290a442f7a20d4db64600d), [`850c1b7`](https://github.com/emdash-cms/emdash/commit/850c1b7e23eb1b083c0fcb753762effa1d3a207a), [`c39789c`](https://github.com/emdash-cms/emdash/commit/c39789c383e94125d8874a516988c7d9ca6f5484)]:
  - emdash@0.19.0

## 0.1.6

### Patch Changes

- Updated dependencies [[`8a766b8`](https://github.com/emdash-cms/emdash/commit/8a766b876117bbb2b7a2179615e83666cdc769e8), [`bdabff7`](https://github.com/emdash-cms/emdash/commit/bdabff7e4b5fb699ef25002508b7edd3ed184061), [`afc065c`](https://github.com/emdash-cms/emdash/commit/afc065c12e6b9a19c30d2cf179fd1ba9667c5b17), [`7ee9467`](https://github.com/emdash-cms/emdash/commit/7ee94677193fb8dd39b87a23b69883f7055ab296), [`f9362d7`](https://github.com/emdash-cms/emdash/commit/f9362d7a89db14420a4a8f7af4e6568f15905ea7)]:
  - emdash@0.18.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`4e11daa`](https://github.com/emdash-cms/emdash/commit/4e11daaaf7c07b20903527626391e31799675da8), [`fe6bc78`](https://github.com/emdash-cms/emdash/commit/fe6bc78e74ecbc41bcae495e070eec9f25e23da2), [`80f2925`](https://github.com/emdash-cms/emdash/commit/80f2925bfbc5f4418363c499c36e0a1c1af04242)]:
  - emdash@0.17.2

## 0.1.4

### Patch Changes

- Updated dependencies [[`149fc49`](https://github.com/emdash-cms/emdash/commit/149fc4904326174075d100ccb4f203b2a250ec64), [`64d5675`](https://github.com/emdash-cms/emdash/commit/64d56759250016fb4bfb2a2ab83106407ffd61a7), [`77fff0a`](https://github.com/emdash-cms/emdash/commit/77fff0a36cd4d6dc242c1d8dd58934ca14cd6dbd), [`87c40d3`](https://github.com/emdash-cms/emdash/commit/87c40d34b3a0130f67bf7d31caf40572f14135e6)]:
  - emdash@0.17.1

## 0.1.3

### Patch Changes

- Updated dependencies [[`cd2dcc6`](https://github.com/emdash-cms/emdash/commit/cd2dcc6a56d19f38d6e13ba55e8563ceaab90ef8), [`62c170f`](https://github.com/emdash-cms/emdash/commit/62c170f11403d76370d6c89f8fa25b0bbcf003fd), [`ee67273`](https://github.com/emdash-cms/emdash/commit/ee67273df089d7ed858542fb0df16650f80cbb15), [`28432b9`](https://github.com/emdash-cms/emdash/commit/28432b9b5a045c9227d59f7762bf9cb37067a950), [`9422d6a`](https://github.com/emdash-cms/emdash/commit/9422d6a744b17f477a3966c3c7e07a087a3345e6), [`1f8190d`](https://github.com/emdash-cms/emdash/commit/1f8190d2dee2f93a0a64ddfbe4f481cb6892ce2b), [`67f5992`](https://github.com/emdash-cms/emdash/commit/67f5992aec23d02c724505632ce951e5b7af9cdb), [`a40e455`](https://github.com/emdash-cms/emdash/commit/a40e455a8de730a61291798a3fe0ee32dde24ed0), [`69bdc97`](https://github.com/emdash-cms/emdash/commit/69bdc97e3e4b69a111b3e5210900e23f35134f8d), [`5e7f835`](https://github.com/emdash-cms/emdash/commit/5e7f83571dbc4832e91881aafbb470407c19b482), [`590b2f9`](https://github.com/emdash-cms/emdash/commit/590b2f97367d6881d8c59e5f0a88e7ad69138acb), [`cd2dcc6`](https://github.com/emdash-cms/emdash/commit/cd2dcc6a56d19f38d6e13ba55e8563ceaab90ef8)]:
  - emdash@0.17.0

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - emdash@0.16.1

## 0.1.1

### Patch Changes

- Updated dependencies [[`e312528`](https://github.com/emdash-cms/emdash/commit/e312528c4560946a43e2e65bd5617733cd98ea75), [`668c5e1`](https://github.com/emdash-cms/emdash/commit/668c5e1a9d2465d1d255ac00375b3d49d67538ba), [`f62c004`](https://github.com/emdash-cms/emdash/commit/f62c0042a2ded0265aed1157054c7326beb125ac), [`47a8350`](https://github.com/emdash-cms/emdash/commit/47a83502fef22d837eb1269ac107858c59cb13e3), [`5456514`](https://github.com/emdash-cms/emdash/commit/54565143205035e475dabb16075e09ade046a74c), [`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558), [`1a4918f`](https://github.com/emdash-cms/emdash/commit/1a4918ff989d57b4f12e44b647542e406dce7cb9), [`7554bd3`](https://github.com/emdash-cms/emdash/commit/7554bd3ba81477383d2616df209050cb29e6ad17), [`33f76b8`](https://github.com/emdash-cms/emdash/commit/33f76b863542a5d040f0e3882cab036e1a410eca), [`e9877e1`](https://github.com/emdash-cms/emdash/commit/e9877e15e4e4ab6906f06342d3e1dbe4532a8acc)]:
  - emdash@0.16.0

## 0.1.0

### Minor Changes

- [#426](https://github.com/emdash-cms/emdash/pull/426) [`02ed8ba`](https://github.com/emdash-cms/emdash/commit/02ed8ba32ef1f4301d84465b934430eee08eef74) Thanks [@BenjaminPrice](https://github.com/BenjaminPrice)! - Adds workerd-based plugin sandboxing for Node.js deployments.
  - **emdash**: Adds `isHealthy()` to `SandboxRunner` interface, `SandboxUnavailableError` class, `sandbox: false` config option, `mediaStorage` field on `SandboxOptions`, and exports `createHttpAccess`/`createUnrestrictedHttpAccess`/`PluginStorageRepository`/`UserRepository`/`OptionsRepository` for platform adapters.
  - **@emdash-cms/cloudflare**: Implements `isHealthy()` on `CloudflareSandboxRunner`. Fixes `storageQuery()` and `storageCount()` to honor `where`, `orderBy`, and `cursor` options (previously ignored, causing infinite pagination loops and incorrect filtered counts). Adds `storageConfig` to `PluginBridgeProps` so `PluginStorageRepository` can use declared indexes.
  - **@emdash-cms/sandbox-workerd**: New package. `WorkerdSandboxRunner` for production (workerd child process + capnp config + authenticated HTTP backing service) and `MiniflareDevRunner` for development.

### Patch Changes

- [#1144](https://github.com/emdash-cms/emdash/pull/1144) [`c50c3b2`](https://github.com/emdash-cms/emdash/commit/c50c3b2fa8a53d12f90d76f009ef82bfd4a47fcd) Thanks [@ascorbic](https://github.com/ascorbic)! - Aligns the `kysely` peer dependency with the rest of the monorepo (`>=0.29.0`) and switches the dev/peer references to the workspace catalog so all packages bump in lockstep going forward.

- [#1147](https://github.com/emdash-cms/emdash/pull/1147) [`20c87fe`](https://github.com/emdash-cms/emdash/commit/20c87fe9248caa276a2083d50b996302deebb0c5) Thanks [@ascorbic](https://github.com/ascorbic)! - Tightens the workerd sandbox internals so the package now lints and type-checks cleanly.
  - Bridge call bodies are validated with predicate-backed `require*` / `optional*` helpers instead of unchecked `as` casts. A misbehaving plugin that sends a malformed JSON-RPC body now gets a clear "Parameter X must be Y" error rather than triggering a downstream type confusion.
  - Content table access (`ec_*` collections) is centralised behind a typed `asContentDb()` helper. Known tables (`users`, `media`, `_plugin_storage`) drop their `as keyof Database` casts entirely.
  - HTTP `init` marshalling validates each field at the bridge boundary, including form-data parts.
  - The backing service uses a typed `HttpError` class for status-bearing errors and validates incoming chunks/body shape defensively.
  - `getPluginStorageConfig()` returns the real `PluginStorageConfig` shape from the manifest instead of `Record<string, unknown>`.
  - `WorkerdSandboxedPlugin` now implements the correct `SandboxedPluginInstance` interface (the old `SandboxedPlugin` symbol did not exist).
  - Adds a `typecheck` script (`tsgo --noEmit`) so the package participates in `pnpm typecheck` going forward.

  No runtime behaviour changes.

- Updated dependencies [[`02ed8ba`](https://github.com/emdash-cms/emdash/commit/02ed8ba32ef1f4301d84465b934430eee08eef74), [`11b3001`](https://github.com/emdash-cms/emdash/commit/11b300100e066c6b3463070a9b65fba868f37e9b), [`fae97ee`](https://github.com/emdash-cms/emdash/commit/fae97ee5465934365864557e9fa3ee8754cfd49c), [`88f544d`](https://github.com/emdash-cms/emdash/commit/88f544db4b8e2f30060a3b4d670ff72aa8760d61), [`9a30607`](https://github.com/emdash-cms/emdash/commit/9a30607791a2f27473b1d2fe7700291e0be1ea1c), [`d0ff94b`](https://github.com/emdash-cms/emdash/commit/d0ff94bd476e7fd4b5d18c94904cfb5c071fea92)]:
  - emdash@0.15.0
