//! libimagequant (imagequant 4.4.1 crate) için tek iş parçacıklı WebAssembly sarmalayıcı.
//! wasm-bindgen yok: düz C ABI. Tüm bellek JS tarafından iq_alloc / iq_free ile yönetilir.
//! Kullanım: iq_alloc → girdi yaz → iq_quantize → iq_palette_* / iq_indices_* oku → iq_release.

use imagequant::RGBA;
use std::cell::RefCell;

struct Output {
    palette: Vec<u8>, // RGBA, 4 bayt / giriş
    indices: Vec<u8>, // piksel başına 1 bayt
    quality: i32,     // 0–100, yoksa -1
}

thread_local! {
    static OUT: RefCell<Option<Output>> = const { RefCell::new(None) };
}

#[no_mangle]
pub extern "C" fn iq_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` iq_alloc ile aynı `len` için üretilmiş olmalı.
#[no_mangle]
pub unsafe extern "C" fn iq_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// RGBA girdiyi (width*height*4 bayt) kuantize eder. Dönüş: 0 başarılı, 1 hata.
/// # Safety
/// `rgba` en az width*height*4 bayt geçerli bellek göstermeli.
#[no_mangle]
pub unsafe extern "C" fn iq_quantize(
    rgba: *const u8,
    width: u32,
    height: u32,
    max_colors: u32,
    speed: i32,
    min_quality: u8,
    target_quality: u8,
) -> i32 {
    let n = width as usize * height as usize;
    let bytes = std::slice::from_raw_parts(rgba, n * 4);
    let pixels: Vec<RGBA> = bytes
        .chunks_exact(4)
        .map(|c| RGBA { r: c[0], g: c[1], b: c[2], a: c[3] })
        .collect();

    let run = || -> Result<Output, imagequant::Error> {
        let mut attr = imagequant::new();
        attr.set_max_colors(max_colors)?;
        attr.set_speed(speed)?;
        attr.set_quality(min_quality, target_quality)?;
        let mut img = attr.new_image(pixels, width as usize, height as usize, 0.0)?;
        let mut res = attr.quantize(&mut img)?;
        let quality = res.quantization_quality().map(|q| q as i32).unwrap_or(-1);
        let (palette, indices) = res.remapped(&mut img)?;
        let palette_bytes: Vec<u8> = palette.iter().flat_map(|c| [c.r, c.g, c.b, c.a]).collect();
        Ok(Output { palette: palette_bytes, indices, quality })
    };

    match run() {
        Ok(out) => {
            OUT.with(|c| *c.borrow_mut() = Some(out));
            0
        }
        Err(_) => {
            OUT.with(|c| *c.borrow_mut() = None);
            1
        }
    }
}

fn with_out<T>(f: impl FnOnce(&Output) -> T, default: T) -> T {
    OUT.with(|c| match c.borrow().as_ref() {
        Some(o) => f(o),
        None => default,
    })
}

#[no_mangle]
pub extern "C" fn iq_palette_ptr() -> *const u8 {
    with_out(|o| o.palette.as_ptr(), std::ptr::null())
}
#[no_mangle]
pub extern "C" fn iq_palette_len() -> usize {
    with_out(|o| o.palette.len(), 0)
}
#[no_mangle]
pub extern "C" fn iq_indices_ptr() -> *const u8 {
    with_out(|o| o.indices.as_ptr(), std::ptr::null())
}
#[no_mangle]
pub extern "C" fn iq_indices_len() -> usize {
    with_out(|o| o.indices.len(), 0)
}
#[no_mangle]
pub extern "C" fn iq_quality() -> i32 {
    with_out(|o| o.quality, -1)
}
#[no_mangle]
pub extern "C" fn iq_release() {
    OUT.with(|c| *c.borrow_mut() = None);
}
