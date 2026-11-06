const fileTypes: { icon: string; extensions: readonly string[] }[] = [
  { icon: 'word', extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf'] },
  { icon: 'table', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'ods', 'csv', 'tsv'] },
  { icon: 'powerpoint', extensions: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'odp'] },
  { icon: 'pdf', extensions: ['pdf'] },
  { icon: 'markdown', extensions: ['md', 'markdown', 'mdown', 'mdx'] },
  { icon: 'json', extensions: ['json', 'jsonc', 'jsonl'] },
  { icon: 'javascript', extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  { icon: 'typescript', extensions: ['ts', 'tsx', 'mts', 'cts'] },
  { icon: 'html', extensions: ['html', 'htm', 'xml'] },
  { icon: 'css', extensions: ['css', 'scss', 'sass', 'less'] },
  { icon: 'python', extensions: ['py', 'pyw', 'ipynb'] },
  { icon: 'go', extensions: ['go'] },
  { icon: 'rust', extensions: ['rs'] },
  { icon: 'yaml', extensions: ['yaml', 'yml'] },
  { icon: 'zip', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'] },
  { icon: 'audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] },
  { icon: 'video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] },
  { icon: 'image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif', 'bmp', 'ico'] },
];

/** Local, original-color Material icons, matching openstudio's file icon family. */
export function FileTypeIcon({ file }: { file: Pick<File, 'name' | 'type'> }) {
  const extension = file.name.includes('.') ? file.name.split('.').at(-1)!.toLowerCase() : '';
  const icon = fileTypes.find((item) => item.extensions.includes(extension))?.icon
    ?? (file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'document');
  return <img className="file-type-icon" src={`/vendor/file-icons/${icon}.svg`} alt="" aria-hidden="true" data-file-icon={icon} width={24} height={24} />;
}
