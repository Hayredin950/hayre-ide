import { Link } from "wouter";

export default function About() {
  return (
    <div className="min-h-screen bg-background text-foreground p-8 font-mono">
      <div className="max-w-3xl mx-auto">
        <header className="mb-12 border-b border-border pb-4 flex justify-between items-center">
          <h1 className="text-4xl font-bold tracking-tighter text-primary">HAYRE_CLI v1.0.0</h1>
          <Link href="/" className="text-primary hover:text-primary-foreground hover:bg-primary px-3 py-1 transition-colors border border-primary">
            [RETURN TO TERMINAL]
          </Link>
        </header>

        <main className="space-y-12">
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center">
              <span className="text-muted-foreground mr-2">&gt;</span> WHOAMI
            </h2>
            <p className="leading-relaxed mb-4 text-lg">
              HayreCLI is an advanced AI-powered web terminal agent. It combines a modern hacker-aesthetic IDE with a powerful autonomous agent capable of executing complex workflows.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center">
              <span className="text-muted-foreground mr-2">&gt;</span> CAPABILITIES
            </h2>
            <ul className="space-y-4">
              <li className="flex items-start">
                <span className="text-primary mr-3">[*]</span>
                <div>
                  <strong className="block mb-1 text-primary">CHAT</strong>
                  <span className="text-muted-foreground">Streaming AI responses with markdown rendering and session persistence.</span>
                </div>
              </li>
              <li className="flex items-start">
                <span className="text-primary mr-3">[*]</span>
                <div>
                  <strong className="block mb-1 text-primary">SHELL</strong>
                  <span className="text-muted-foreground">Execute bash commands with structured stdout/stderr outputs.</span>
                </div>
              </li>
              <li className="flex items-start">
                <span className="text-primary mr-3">[*]</span>
                <div>
                  <strong className="block mb-1 text-primary">FILES</strong>
                  <span className="text-muted-foreground">Read, write, and explore the workspace filesystem.</span>
                </div>
              </li>
              <li className="flex items-start">
                <span className="text-primary mr-3">[*]</span>
                <div>
                  <strong className="block mb-1 text-primary">CODE</strong>
                  <span className="text-muted-foreground">Execute arbitrary code in isolated environments (Python, Node, Go, Rust, C++).</span>
                </div>
              </li>
              <li className="flex items-start">
                <span className="text-primary mr-3">[*]</span>
                <div>
                  <strong className="block mb-1 text-primary">BROWSE</strong>
                  <span className="text-muted-foreground">Fetch and render web content to inform the agent's context.</span>
                </div>
              </li>
              <li className="flex items-start">
                <span className="text-primary mr-3">[*]</span>
                <div>
                  <strong className="block mb-1 text-primary">MEMORY</strong>
                  <span className="text-muted-foreground">Persistent key-value store across sessions for long-term agent context.</span>
                </div>
              </li>
              <li className="flex items-start">
                <span className="text-primary mr-3">[*]</span>
                <div>
                  <strong className="block mb-1 text-primary">AGENT</strong>
                  <span className="text-muted-foreground">Autonomous multi-step execution loop that leverages all tools.</span>
                </div>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center">
              <span className="text-muted-foreground mr-2">&gt;</span> SYSTEM_STATUS
            </h2>
            <div className="bg-card border border-border p-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-muted-foreground">KERNEL:</span>
                  <span className="ml-2 text-primary">HayreOS 1.0</span>
                </div>
                <div>
                  <span className="text-muted-foreground">UPTIME:</span>
                  <span className="ml-2 text-primary">99.99%</span>
                </div>
                <div>
                  <span className="text-muted-foreground">MODEL:</span>
                  <span className="ml-2 text-primary">Claude-3.5-Sonnet</span>
                </div>
                <div>
                  <span className="text-muted-foreground">STATUS:</span>
                  <span className="ml-2 text-primary animate-pulse">ONLINE</span>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
