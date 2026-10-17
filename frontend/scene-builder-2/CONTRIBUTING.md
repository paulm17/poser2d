# Contributing to Pose Toolkit

First off, thank you for considering contributing to Pose Toolkit! It's people like you that make this tool better for everyone.

## Code of Conduct
By participating in this project, you are expected to uphold a welcoming and inclusive environment for everyone. Please be respectful and constructive in issues and pull requests.

## How Can I Contribute?

### Reporting Bugs
* Ensure the bug was not already reported by searching on GitHub under Issues.
* If you're unable to find an open issue addressing the problem, open a new one. 
* Be sure to include a title, a clear description, your OS/browser version, and steps to reproduce the issue.

### Suggesting Enhancements
* Open a new issue with a clear title and description.
* Explain why this enhancement would be useful to most users.
* Provide mockups or specific examples if applicable.

### Pull Requests
1. Fork the repo and create your feature branch from `main` (`git checkout -b feature/amazing-feature`).
2. Make your changes, ensuring you follow the existing code style.
3. Commit your changes with descriptive commit messages (`git commit -m 'Add some amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request!

## Local Development Setup

### Prerequisites
* **Node.js** (v16 or higher recommended)
* **npm** (comes with Node.js)
* A modern web browser

### Quick Start
You can use the provided start scripts to automatically install dependencies and start the development server:
* **Windows:** Double-click or run `start.bat` in your terminal.
* **Mac/Linux:** Run `./start.sh` (ensure it has executable permissions: `chmod +x start.sh`).

### Manual Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/fanverseio/pose-toolkit.git
   cd pose-toolkit
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   ```

## Project Structure
* `index.html` - The main entry point, UI layout, and HTML structure.
* `src/` - Contains the core application logic:
  * `main.js` - Three.js scene setup, mannequin initialization, IK (Inverse Kinematics) handling, and general interaction logic.
  * `exportSystem.js` - Logic for the ratio-based cropping, resizing the export frame, and exporting images.
  * `style.css` - Application styling and UI themes.

## Licensing and Attribution
This project is licensed under the **GPL-3.0 License**. By contributing to this repository, you agree that your contributions will be licensed under the same GPL-3.0 License.

**Important:** This project uses `mannequin.js` as its articulated human figure foundation (https://github.com/boytchev/mannequin.js/). When adding features related to the human figure generation or procedural geometry, ensure we maintain proper attribution and comply with its GPL-3.0 license.
