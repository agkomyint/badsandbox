use bag_core::{default_design, generate, parse, pattern_pdf, pattern_svg, Paper, STYLES};
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "bag", version, about = "Parametric bag engine: design JSON -> 3D mesh + sewing pattern")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print a default design for a style (or write it with -o)
    New {
        #[arg(default_value = "tote")]
        style: String,
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Build pattern / mesh files from a design. With no outputs given, writes <name>.pdf and <name>.svg
    Build {
        design: PathBuf,
        /// Pattern PDF output
        #[arg(long)]
        pdf: Option<PathBuf>,
        /// Paper for the PDF: a4, letter or full
        #[arg(long, default_value = "a4")]
        paper: String,
        /// Full-scale pattern SVG output
        #[arg(long)]
        svg: Option<PathBuf>,
        /// 3D mesh as Wavefront OBJ (cm)
        #[arg(long)]
        obj: Option<PathBuf>,
        /// Raw engine output (pattern + mesh) as JSON
        #[arg(long)]
        json: Option<PathBuf>,
    },
    /// Print dimensions, cut list and warnings
    Info { design: PathBuf },
    /// List available styles
    Styles,
}

fn load(p: &Path) -> Result<bag_core::Design, String> {
    let s = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    parse(&s)
}

fn write(p: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, data).map_err(|e| format!("{}: {e}", p.display()))?;
    println!("wrote {}", p.display());
    Ok(())
}

fn run() -> Result<(), String> {
    match Cli::parse().cmd {
        Cmd::Styles => STYLES.iter().for_each(|s| println!("{s}")),
        Cmd::New { style, out } => {
            let json = serde_json::to_string_pretty(&default_design(&style)?).unwrap();
            match out {
                Some(p) => write(&p, json.as_bytes())?,
                None => println!("{json}"),
            }
        }
        Cmd::Info { design } => {
            let out = generate(&load(&design)?)?;
            println!("{} ({})", out.pattern.name, out.pattern.style);
            println!("params: {}", serde_json::to_string_pretty(&out.params).unwrap());
            println!("\ncut list:");
            for p in &out.pattern.pieces {
                println!("  {:<14} {:<24} {}", p.name, p.cut, p.notes.join("; "));
            }
            for w in &out.pattern.warnings {
                println!("warning: {w}");
            }
        }
        Cmd::Build { design, pdf, paper, svg, obj, json } => {
            let out = generate(&load(&design)?)?;
            for w in &out.pattern.warnings {
                eprintln!("warning: {w}");
            }
            let (pdf, svg) = if pdf.is_none() && svg.is_none() && obj.is_none() && json.is_none() {
                (Some(design.with_extension("pdf")), Some(design.with_extension("svg")))
            } else {
                (pdf, svg)
            };
            if let Some(p) = pdf {
                write(&p, &pattern_pdf(&out, Paper::parse(&paper)?))?;
            }
            if let Some(p) = svg {
                write(&p, pattern_svg(&out).as_bytes())?;
            }
            if let Some(p) = obj {
                write(&p, out.mesh.to_obj().as_bytes())?;
            }
            if let Some(p) = json {
                write(&p, serde_json::to_string(&out).unwrap().as_bytes())?;
            }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
