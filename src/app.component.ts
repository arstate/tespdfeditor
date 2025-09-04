import { Component, signal, ChangeDetectionStrategy, ViewChild, ElementRef, WritableSignal, computed } from '@angular/core';

// Declare global variables from CDN scripts
declare var pdfjsLib: any;
declare var PDFLib: any;

interface TextItem {
  str: string;
  dir: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  @ViewChild('pdfCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  isLoading = signal(false);
  pdfFileBuffer: WritableSignal<ArrayBuffer | null> = signal(null);
  pdfDocProxy: WritableSignal<any> = signal(null);
  
  currentPage = signal(1);
  totalPages = signal(0);
  zoom = signal(1.25);
  roundedZoom = computed(() => Math.round(this.zoom() * 100));

  canvasWidth = signal(0);
  canvasHeight = signal(0);

  textItems = signal<TextItem[]>([]);
  editedTexts = signal<Map<number, Map<number, string>>>(new Map());

  // Promise to track script loading status, ensuring we only load them once.
  private scriptsLoadedPromise: Promise<void> | null = null;

  triggerFileUpload(): void {
    this.fileInputRef.nativeElement.click();
  }

  private loadScript(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if script already exists to avoid duplications
      if (document.querySelector(`script[src="${url}"]`)) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
      document.body.appendChild(script);
    });
  }

  private loadPdfLibraries(): Promise<void> {
    if (!this.scriptsLoadedPromise) {
      this.scriptsLoadedPromise = Promise.all([
        this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.js'),
        this.loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js')
      ]).then(() => {
        // After pdf.js is loaded, configure its worker. This is a crucial step.
        if (typeof pdfjsLib !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.js';
        }
      }).catch(error => {
        // If loading fails, reset the promise so we can try again on a subsequent action.
        this.scriptsLoadedPromise = null;
        throw error;
      });
    }
    return this.scriptsLoadedPromise;
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      return;
    }

    const file = input.files[0];
    if (file.type !== 'application/pdf') {
      alert('Please select a PDF file.');
      return;
    }
    
    this.isLoading.set(true);

    try {
      // Dynamically load scripts and wait for them to be ready.
      await this.loadPdfLibraries();
      
      const fileBuffer = await file.arrayBuffer();
      this.pdfFileBuffer.set(fileBuffer);
      
      // Defer PDF loading to allow the canvas to render first.
      setTimeout(async () => {
        try {
          await this.loadPdf(fileBuffer);
        } catch (error) {
          console.error('Error loading PDF:', error);
          alert('Failed to load PDF file.');
          this.pdfFileBuffer.set(null); // Reset UI on failure
          this.isLoading.set(false);
        }
      }, 0);
    } catch (error) {
      console.error('Error during file processing:', error);
      alert('Failed to load required PDF libraries. Please check your internet connection and try again.');
      this.isLoading.set(false);
    } finally {
      input.value = ''; // Reset file input
    }
  }

  private async loadPdf(fileBuffer: ArrayBuffer): Promise<void> {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) });
    const pdf = await loadingTask.promise;
    
    this.pdfDocProxy.set(pdf);
    this.totalPages.set(pdf.numPages);
    this.currentPage.set(1);
    this.editedTexts.set(new Map());
    
    await this.renderPage(1);
  }

  async renderPage(pageNum: number): Promise<void> {
    if (!this.pdfDocProxy() || pageNum < 1 || pageNum > this.totalPages()) {
      return;
    }
    
    if (!this.canvasRef) {
      console.error('Render called before canvas was ready.');
      return;
    }

    this.isLoading.set(true);
    this.currentPage.set(pageNum);

    try {
      const page = await this.pdfDocProxy().getPage(pageNum);
      const viewport = page.getViewport({ scale: this.zoom() });

      const canvas = this.canvasRef.nativeElement;
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      this.canvasWidth.set(canvas.width);
      this.canvasHeight.set(canvas.height);

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
      };
      await page.render(renderContext).promise;

      // Render text layer for editing
      const textContent = await page.getTextContent();
      this.textItems.set(textContent.items);
    } catch(e) {
      console.error('Failed to render page', e);
      alert('An error occurred while rendering the page.');
    } finally {
      this.isLoading.set(false);
    }
  }

  updateText(itemIndex: number, event: Event): void {
    const newText = (event.target as HTMLElement).innerText;
    this.editedTexts.update(currentMap => {
      const pageEdits = currentMap.get(this.currentPage()) ?? new Map<number, string>();
      pageEdits.set(itemIndex, newText);
      currentMap.set(this.currentPage(), pageEdits);
      return new Map(currentMap);
    });
  }

  goToPrevPage(): void {
    if (this.currentPage() > 1) {
      this.renderPage(this.currentPage() - 1);
    }
  }

  goToNextPage(): void {
    if (this.currentPage() < this.totalPages()) {
      this.renderPage(this.currentPage() + 1);
    }
  }

  zoomIn(): void {
    this.zoom.update(z => Math.min(z + 0.25, 3));
    this.renderPage(this.currentPage());
  }

  zoomOut(): void {
    this.zoom.update(z => Math.max(z - 0.25, 0.5));
    this.renderPage(this.currentPage());
  }

  async downloadPdf(): Promise<void> {
    const originalFileBuffer = this.pdfFileBuffer();
    if (!originalFileBuffer || typeof PDFLib === 'undefined') {
        alert('No PDF loaded or PDF library not available.');
        return;
    }
    
    if (this.editedTexts().size === 0) {
      alert("No changes have been made.");
      return;
    }
    
    this.isLoading.set(true);

    try {
      const { PDFDocument, rgb, StandardFonts } = PDFLib;

      const pdfDoc = await PDFDocument.load(originalFileBuffer);
      const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const pages = pdfDoc.getPages();

      for (const [pageNum, edits] of this.editedTexts().entries()) {
        const pageIndex = pageNum - 1;
        if (pageIndex < 0 || pageIndex >= pages.length) continue;

        const page = pages[pageIndex];
        const { height: pageHeight } = page.getSize();
        
        const pdfJsPage = await this.pdfDocProxy().getPage(pageNum);
        const textContent = await pdfJsPage.getTextContent();
        
        for (const [itemIndex, newText] of edits.entries()) {
            if (itemIndex >= textContent.items.length) continue;

            const item = textContent.items[itemIndex];
            const viewport = pdfJsPage.getViewport({ scale: 1 }); // Use scale 1 for original coords

            const tx = item.transform;
            const textWidth = item.width;
            const textHeight = item.height;

            const x = tx[4];
            const y = viewport.height - tx[5];

            page.drawRectangle({
              x: x,
              y: y,
              width: textWidth,
              height: textHeight,
              color: rgb(1, 1, 1),
            });

            page.drawText(newText, {
              x: x,
              y: y, 
              font: helveticaFont,
              size: textHeight * 0.9, 
              color: rgb(0, 0, 0),
            });
        }
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'edited_document.pdf';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

    } catch (error) {
      console.error('Error saving PDF:', error);
      alert('An error occurred while saving the PDF.');
    } finally {
      this.isLoading.set(false);
    }
  }

  // Utility function for template
  getEditedText(itemIndex: number): string {
    return this.editedTexts().get(this.currentPage())?.get(itemIndex) ?? this.textItems()[itemIndex].str;
  }
}