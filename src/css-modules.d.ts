declare module '*.module.css' {
  const classes: Record<string, string>
  export function install(): () => void
  export default classes
}

declare module '*.css'
