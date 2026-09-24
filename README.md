# img2threejs Studio

Bir veya birden fazla referans görseli, açık kaynaklı [img2threejs](https://github.com/img2threejs/img2threejs) pipeline'ı ile **tamamen kod-tabanlı, prosedürel bir Three.js 3D oyun modeline** dönüştüren statik web uygulaması.

- Kullanıcı bir görsel ya da **aynı nesnenin birden fazla açısını** (ön, yan, arka, üst; en fazla 6) yükler, OpenRouter'daki görsel destekli modellerden birini seçer ve kendi API anahtarını girer.
- img2threejs'in orijinal Python scriptleri tarayıcıda (Pyodide) çalışır: intake → spec → strict-quality kapısı → Three.js factory üretimi.
- Model sitede incelenir (orbit, ışık modları, parçalara ayırma, wireframe) ve **Oyun testi** modunda sürülüp zıplatılarak denenir.
- **İyileştir** turları img2threejs'in "Divine Eye" döngüsünü uygular: karşılaştırma sayfası, map-stripped render, katman/feature skorları, `append_review.py` kaydı ve spec düzeltmesi.
- Pipeline'ın her adımında çalışan kod (komut, orijinal Python kaynağı, LLM prompt'u ve yanıtı) görüntülenebilir.
- Çıktılar: GLB, Three.js TS/JS modülü, tek dosya HTML embed, React Three Fiber bileşeni, ObjectSculptSpec. Hepsi ZIP olarak da indirilebilir.

Sunucu yok. Görsel ve API anahtarı yalnızca kullanıcının tarayıcısında işlenir ve sadece OpenRouter'a gönderilir.

## Proje yapısı

```
site/                       ← Cloudflare Worker'ın statik olarak sunduğu klasör (build adımı yok)
  index.html, css/, js/
  py/studio_pipeline.py     ← Pyodide adaptörü (brief → ObjectSculptSpec, forge çağrıları)
  forge.zip                 ← img2threejs forge/ + docs/ + grimoire/ paketi (scripts/build_forge_bundle.py üretir)
  forge-manifest.json       ← paketlenen upstream commit ve dosya listesi
  _headers                  ← Cloudflare başlıkları
  demo/mug.json             ← geliştirme için örnek brief (?demo=demo/mug.json)
vendor/img2threejs/         ← img2threejs'in vendored kopyası (Apache-2.0)
scripts/
  build_forge_bundle.py     ← forge.zip'i üretir (--update ile upstream'i yeniden çeker)
  dev_server.py             ← yerel önizleme (cache kapalı)
wrangler.toml               ← Cloudflare Workers yapılandırması (static assets: ./site)
```

## Yerelde çalıştırma

Python 3.10+ yeterli:

```bash
python scripts/dev_server.py 8765
```

Ardından http://localhost:8765 adresini aç. LLM çağırmadan pipeline'ı denemek için: http://localhost:8765/?demo=demo/mug.json

## Cloudflare'e subdomain olarak deploy

Site, sunucu kodu olmayan bir **Cloudflare Worker** olarak yayınlanır: `wrangler.toml` içindeki `[assets]` ayarı `site/` klasörünü statik dosya olarak sunar, `site/_headers` başlıkları uygular.

### Seçenek A: GitHub + Cloudflare Workers (önerilen, her push'ta otomatik deploy)

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository** → GitHub'ı bağla ve repoyu seç.
2. Ayarlar:
   - Project name: `image-to-3d-game` (`wrangler.toml` içindeki `name` ile aynı olmalı)
   - Build command: *(boş bırak)*
   - Deploy command: `npx wrangler deploy`
3. **Deploy**. Site `https://image-to-3d-game.<hesap-adın>.workers.dev` adresinde yayına girer.
   Bundan sonra `main` dalına her push otomatik deploy olur.
4. Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain** → örn. `3d.alanadin.com`.
   Alan adın Cloudflare'de ise DNS kaydı ve SSL otomatik ayarlanır.

### Seçenek B: Wrangler ile bilgisayardan deploy

```bash
npx wrangler login
npx wrangler deploy
```

Yapılandırmayı yüklemeden denemek için: `npx wrangler deploy --dry-run`. Subdomain'i yine Dashboard → Worker → **Settings** → **Domains & Routes** üzerinden ekle.

## img2threejs'i güncelleme

```bash
python scripts/build_forge_bundle.py --update   # upstream'i yeniden klonlar ve site/forge.zip'i üretir
```

Güncellemeden sonra `?demo=demo/mug.json` ile strict-quality ve codegen'in hâlâ geçtiğini kontrol et. Upstream spec şeması değiştiyse `site/py/studio_pipeline.py` içindeki `expand_brief` fonksiyonunun güncellenmesi gerekebilir.

## Çoklu referans görsel

img2threejs'in spec şeması çok görünümlüdür: `viewEvidence` bir listedir ve her bileşen, detay ve inceleme hedefi `evidenceRefs` ile hangi görselde görüldüğünü belirtir. Studio bunu şöyle kullanır:

- Her yüklenen görsel bir `viewEvidence` girdisi olur. Birincil görselin id'si `full-object`, diğerleri `view-2-side`, `view-3-back` biçimindedir.
- Görsellerin tümü tek mesajda vision modeline gider; model her parçanın hangi açıda göründüğünü `evidence` alanıyla bildirir. Geçersiz id'ler genişletme sırasında elenir.
- `probe_image.py` her görsel için ayrı çalışır; dosyalar Pyodide dosya sisteminde `/work/reference.png` ve `/work/refs/<n>-<açı>.png` olarak durur.
- İyileştirme turunda karşılaştırma sayfasının yanında ek açılar da incelemeye gönderilir.
- Tek görselle çalışıldığında davranış değişmez: tek bir `full-object` görünümü oluşur.

`visual_hull` (çoklu silüetten oyma) yolu henüz kullanılmıyor; bu, modelden ikili silüet maskesi istemeyi gerektirir.

## Nasıl çalışır (teknik)

1. `probe_image.py`: yüklenen her görselin teknik uygunluğu.
2. **Vision LLM** (OpenRouter): yüklenen tüm görselleri img2threejs kurallarıyla inceler ve kompakt bir **SculptBrief** JSON'u yazar (sınıf, karmaşıklık, detay envanteri, bileşen ağacı, primitifler, ölçüler, malzemeler, ışık). Kod yazmaz.
3. `new_pre_spec_assessment.py` + `new_sculpt_spec.py`: starter ObjectSculptSpec.
4. `expand_brief()` (Studio adaptörü): brief'i spec alanlarına yerleştirir (attachment uç noktaları, primitif birim ölçekleri, malzeme PBR alanları, repetition sistemleri).
5. `validate_sculpt_spec.py --strict-quality`: hatalar LLM'e geri verilir ve brief düzeltilir (varsayılan en fazla 3 deneme).
6. `generate_threejs_factory.py`: TypeScript factory. Sucrase ile JS'e çevrilir ve import map üzerinden three.js ile çalıştırılır.
7. **İyileştir**: `make_comparison_sheet.py` ile yan yana karşılaştırma sayfası, map-stripped render, LLM incelemesi, `append_review.py` ile kayıt. Pass, ancak img2threejs'in kapıları (eşik, zorunlu katman skorları, kritik feature skorları, kanıt dosyaları) onaylarsa ilerler.

### Dürüst sınırlar

- Tek görsel gizli yüzleri gösteremez; bu kısımlar tahmindir ve spec'te `assumptions`/`unknowns` olarak işaretlenir. Birden fazla açı yüklemek tahmini azaltır ama tamamen ortadan kaldırmaz: hiçbir görselde görünmeyen bölgeler yine tahmindir.
- Hızlı dönüşümde tüm build pass'leri tek seferde üretilir ve **"incelenmemiş önizleme"** olarak etiketlenir. Pass başına görsel onay "İyileştir" turlarıyla verilir.
- PBR değerleri `extract_pbr_evidence.py` ile piksel çıkarımıyla değil, vision modelinin tahminiyle belirlenir. Bu durum spec'te `skipReason` ve `risks` olarak kaydedilir.
- Sonuç kalitesi seçilen modele bağlıdır. Güçlü vision modelleri (Claude Sonnet/Opus, Gemini Pro, GPT-5 sınıfı) belirgin şekilde daha iyi sonuç verir.

## Lisans

img2threejs: Apache-2.0 (© img2threejs contributors). `vendor/img2threejs/LICENSE` dosyasına bakın.
