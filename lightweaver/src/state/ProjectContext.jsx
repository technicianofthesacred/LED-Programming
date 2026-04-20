import { createContext, useContext, useState } from 'react';

const ProjectContext = createContext(null);

export function ProjectProvider({ children }) {
  const [strips, setStrips] = useState([]);
  const [viewBox, setViewBox] = useState('0 0 640 400');
  const [svgText, setSvgText] = useState(null);
  const [hidden, setHidden] = useState({});
  return (
    <ProjectContext.Provider value={{ strips, setStrips, viewBox, setViewBox, svgText, setSvgText, hidden, setHidden }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
